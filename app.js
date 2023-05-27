require('dotenv').config();
let { SERVER_SERIES } = process.env;
SERVER_SERIES = Number(SERVER_SERIES);

const listenPort = 6250;
const privateKeyPath = `/home/sslkeys/instantchatbot.net.key`;
const fullchainPath = `/home/sslkeys/instantchatbot.net.pem`;

const express = require('express');
const https = require('https');
const cors = require('cors');
const fs = require('fs');
const fsPromise = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const redis = require('redis');

const jwtUtil = require('./utils/jwt');
const qdrant = require('./utils/qdrant');
const mysql = require('./utils/mysql');
const openai = require('./utils/openai');

const adminCommands = [];

const {OPENAI_API_KEY, PYMNTS_OPENAI_KEY, JWT_SECRET} = process.env;

const chunksHost = `chunks-${SERVER_SERIES}.instantchatbot.net`;
const qdrantHost = `qdrant-${SERVER_SERIES}.instantchatbot.net`;
const appHost = `app-${SERVER_SERIES}.instantchatbot.net`;

const { CONFIG_MYSQL_HOST, CONFIG_MYSQL_DATABASE, CONFIG_MYSQL_USER, CONFIG_MYSQL_PASSWORD } = process.env;
const configPool = mysql.connect(CONFIG_MYSQL_HOST, CONFIG_MYSQL_USER, CONFIG_MYSQL_PASSWORD, CONFIG_MYSQL_DATABASE);

const { CHUNKS_MYSQL_PASSWORD} = process.env;
const chunksDb = mysql.connect(chunksHost, 'chunks', CHUNKS_MYSQL_PASSWORD, 'chunks');

const sleep = seconds => new Promise(r => setTimeout(r, seconds * 1000));

var redisClient = redis.createClient(6379, "127.0.0.1");  

redisClient.on('error', (err) => console.log('Redis Client Error', err));

const connectToRedis = async client => {
    await client.connect();

    await client.set('greeting', 'hello world from redis');
    const value = await client.get('greeting');

    console.log(value);

    await client.flushAll();
}

connectToRedis(redisClient); 

const handleSuppliedToken = (bt, res) => {
    console.log('bt', bt);
    const tokenInfo = jwtUtil.extractToken(bt, true);
    if (!tokenInfo.status) {
        res.status(401).json('unauthorized');
        return false;
    }

    const token = tokenInfo.msg;

    console.log('token', token);

    if (token.serverSeries !== SERVER_SERIES) {
        res.status(400).json(`bad request: serverSeries ${token.serverSeries}:${typeof token.serverSeries} vs ${SERVER_SERIES}:${typeof SERVER_SERIES}`);
        return false;
    }

    return token
}


const getUserStats = async userId => {
    let result;

    try {
        result = await redisClient.hGetAll(userId);
    } catch (err) {
        console.error(err);
        return false;
    }
    console.log ('redis', result);
    
    const numKeys = Object.keys(result).length;

    if (numKeys) return {
        credit: Number(result.credit),
        date: result.date,
        storage: Number(result.storage),
        upload: Number(result.upload),
        queries: Number(result.queries)
    }

    if (!numKeys) {
        let q = `SELECT credit, next_charge_date, max_storage_mb, upload_mb, queries FROM account WHERE user_id = '${userId}'`;
        
        try {
            result = await mysql.query(configPool, q);
        } catch (err) {
            console.error(err);
            return false;
        }

        console.log('mysql', result);

        const credit = result[0].credit;
        const date = result[0].next_charge_date;
        const storage = result[0].max_storage_mb;
        const upload = result[0].upload_mb;
        const queries = result[0].queries;

        try {
            result = await redisClient.hSet(userId, 'credit', credit);
            result = await redisClient.hSet(userId, 'date', date);
            result = await redisClient.hSet(userId, 'storage', storage);
            result = await redisClient.hSet(userId, 'upload', upload);
            result = await redisClient.hSet(userId, 'queries', queries);
            return {credit, date, storage, upload, queries};
        } catch (err) {
            console.error(err);
            return {credit, date, storage, upload, queries};
        }
    }
}

const getCreditNeeded = (botType, uploadSize, storageSize, queries) => {
    if (typeof uploadSize === 'string') uploadSize = Number(uploadSize);
    if (typeof storageSize === 'string') storageSize = Number(storageSize);
    if (typeof queries === 'string') queries = Number(queries);

    let creditNeeded;
    let storageMb = Math.ceil(storageSize / 1000000);
    let uploadMb = Math.ceil(uploadSize / 1000000);
    let queryChunks = Math.ceil(queries / 1000);

    console.log('mb', storageMb, uploadMb);

    switch (botType) {
        case 'standard':
            creditNeeded = (275 * storageMb) + (25 * uploadMb) + (100 * queryChunks);
            break;
        default:
            console.error('creditNeeded Error: Unknown botType', botType);
            return false;
    }

    console.log('creditNeeded', creditNeeded);
    return creditNeeded;
}

setTimeout(async () => {
    const val = await getUserStats('50a0ec91-4ef9-4685-af71-4e9c05f4169c');
    console.log('val', val);
}, 1000)

setTimeout(async () => {
    const val = await getUserStats('50a0ec91-4ef9-4685-af71-4e9c05f4169c');
    console.log('val', val);
}, 2000)

const app = express();
app.use(express.static('public'));
app.use(express.json({limit: '500mb'})); 
app.use(cors());

app.get('/', (req, res) => {
    res.send('Hello, World!');
});

function decodeToken(info) {
    // if invalid return false
    if (!jwt.verify(info, JWT_SECRET)) return false;

    const token = jwt.decode(info);
    const curTime = new Date();

    // if expired return false
    if (token.exp < curTime.getTime()/1000) return false;

    return token;
}





const aiQuery = (req, res) => {
    return new Promise(async (resolve, reject) => {
        const { prompt, token } = req.body;

        console.log(`${prompt}\n\n`);
        /*
         * TODO: Store the prompts in a database
         */


        if (!prompt || !token) {
            res.status(400).json({error: 'invalid'});
            return resolve('error: 400');
        }
    
        const decodedToken = decodeToken(token);
    
        if (decodedToken === false) {
            res.status(401).json({error: 'invalid'});
            return resolve('error: invalid');
        }

        console.log(decodedToken);
        const { botId, openAIKey, domains, serverSeries } = decodedToken;        

        if (!botId || !openAIKey || !domains || !serverSeries) {
            res.status(401).json({error: 'invalid 3'});
            return resolve('error: invalid 3');
        }

        const origin = req.headers.origin;
    
        const url = new URL(origin);
    
        const test = decodedToken.domains ? decodedToken.domains.find(domain => domain === url.host) : null;
    
        if (!test) {
            res.status(401).json({error: 'invalid request'});
            return resolve('error: invalid request');
        }
    
        //console.log(decodedToken);
        
        const qdrantHost = `qdrant-${SERVER_SERIES}.instantchatbot.net`

        const contextIds = await qdrant.getContextIds(qdrantHost, 6333, botId, openAIKey, prompt, 3);

        if (!contextIds.length) {
            res.status(401).json({error: 'invalid request 4'});
            return resolve('error: invalid request');
        }

        console.log(contextIds);

        let q = `SELECT text FROM chunk WHERE chunk_id = '${contextIds[0]}'`;

        for (let i = 1; i < contextIds.length; ++i) q += ` OR chunk_id = '${contextIds[i]}'`;

        let result;

        try {
            result = await mysql.query(chunksDb, q);
        } catch (err) {
            console.error(err);
            res.status(200).json({bot: "Something went wrong. Please try again later."});
            return resolve('error');
        }

        console.log(result);

        const contexts = result.map(result => result.text);

        const query = openai.createContextBasedPrompt(prompt, contexts);

        console.log(query);

        let answer = await openai.getGptTurboSingeShotResponse(query, openAIKey);

        res.status(200).json({bot: answer});
        resolve('ok');
        return;

//        let answer = await qdrant.getDavinciResponse(query, openAIKey);



        //console.log(contexts);

        // convert query into embedding

        
        
        res.status(200).json({bot: answer});



        resolve('ok');
    })
}

const addStorage = async (req, res) => {
    const { size, botToken } = req.body;

    const token = handleSuppliedToken(botToken, res);
    if (!token) return;

    const { userName, botId, userId, botType } = token;

    console.log('token', token);

    let stats = await getUserStats(userId);
    if (!stats) return res.status(500).json('addStorage error: Incorrect userId');

    let storage = Number(stats.storage);
    let credit = Number(stats.credit);
    let queries = Number(stats.queries);
    let upload = Number(stats.upload);

    storage += size;
    upload += size;

    console.log('stats', stats);

    let creditNeeded = getCreditNeeded(botType, upload, storage, queries);

    if (credit < creditNeeded) {
        return res.status(402).json('credit needed');
    }

    res.status(510).json('debug');
}

const handleAdminCommands = async () => {
    while(1) {
        if (!adminCommands.length) {
            await sleep(.25);
            continue;
        }
        const admin = adminCommands.shift();
        console.log('admin', admin);
        const {command, req, res} = admin;
    
        try {
            
            switch (command) {
                case 'addStorage':
                    await addStorage(req, res);
                    break;
            }
        } catch (err) {
            console.error('handleAdminCommands Error', err);
            res.status(500).json(`Could not process command: ${command}`);
        }
    }   
}

handleAdminCommands();

app.post('/ai-query', (req, res) => aiQuery(req, res));
app.post('/addStorage', (req, res) => adminCommands.push({command: 'addStorage', req, res}));

const httpsServer = https.createServer({
    key: fs.readFileSync(privateKeyPath),
    cert: fs.readFileSync(fullchainPath),
  }, app);
  

  httpsServer.listen(listenPort, '0.0.0.0', () => {
    console.log(`HTTPS Server running on port ${listenPort}`);
});
