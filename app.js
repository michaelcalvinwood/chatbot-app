require('dotenv').config();
const { SERVER_SERIES } = process.env;

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

const qdrant = require('./utils/qdrant');
const mysql = require('./utils/mysql');
const openai = require('./utils/openai');

const {OPENAI_API_KEY, PYMNTS_OPENAI_KEY, JWT_SECRET} = process.env;

const chunksHost = `chunks-${SERVER_SERIES}.instantchatbot.net`;
const qdrantHost = `qdrant-${SERVER_SERIES}.instantchatbot.net`;
const appHost = `app-${SERVER_SERIES}.instantchatbot.net`;

const { CHUNKS_MYSQL_PASSWORD} = process.env;
const chunksDb = mysql.connect(chunksHost, 'chunks', CHUNKS_MYSQL_PASSWORD, 'chunks');

var redisClient = redis.createClient(6379, "127.0.0.1");  

redisClient.on('error', (err) => console.log('Redis Client Error', err));

const connectToRedis = async client => {
    await client.connect();

    await client.set('greeting', 'hello world from redis');
    const value = await client.get('greeting');

    console.log(value);
}

connectToRedis(redisClient); 

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
    const { userId, storageAmount } = req.body;

    if (!userId || !storageAmount) return res.status(400).json('bad request');

    
}

app.post('/ai-query', (req, res) => aiQuery(req, res));
app.post('addStorage', (req, res) => addStorage(req, res));

const httpsServer = https.createServer({
    key: fs.readFileSync(privateKeyPath),
    cert: fs.readFileSync(fullchainPath),
  }, app);
  

  httpsServer.listen(listenPort, '0.0.0.0', () => {
    console.log(`HTTPS Server running on port ${listenPort}`);
});
