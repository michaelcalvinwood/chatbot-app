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

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const pendingPurchases = {};

const {OPENAI_API_KEY, PYMNTS_OPENAI_KEY, JWT_SECRET, ORDER_SECRET_KEY} = process.env;

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

const storageTokenCost = 275; // per mb of storage
const uploadCost = 25; // per mb of upload
const tokenCost = 100; // per 100 queries

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

const getUserRedisStats = async userId => {
    let result;

    console.log('getUserStats userId', userId);

    try {
        result = await redisClient.hGetAll(userId);
    } catch (err) {
        console.error(err);
        return false;
    }
    console.log ('redis', result);
    
    const numKeys = Object.keys(result).length;

    console.log('numKeys', numKeys);

    if (numKeys) return {
        credit: Number(result.credit),
        date: result.date,
        storage: Number(result.storage),
        upload: Number(result.upload),
        queries: Number(result.queries)
    }

    return false;
}

const getUserStats = async userId => {
    let redisStats = await getUserRedisStats(userId);
    console.log('getUserStats redisStats', redisStats);

    if (redisStats !== false) return redisStats;

    let q = `SELECT credit, next_charge_date, max_storage_mb, upload_mb, queries FROM account WHERE user_id = '${userId}'`;
    
    let result;
    try {
        result = await mysql.query(configPool, q);
    } catch (err) {
        console.error(err);
        return false;
    }

    console.log('getUserStats userId, result', userId, result);
    if (!result.length) return false;

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
    } catch (err) {
        console.error(err);
    }

    return {credit: Number(credit), date, storage: Number(storage), upload: Number(upload), queries: Number(queries)};
    
}

const getCreditsRemaining = async userId => {
    console.log('getCreditsRemaining userId', userId);
    const result = await getUserStats(userId);
   if (result === false) return false;


    const creditsUsed = (Math.ceil(result.storage) * storageTokenCost) + (Math.ceil(result.upload) * uploadCost) + (Math.ceil(result.queries/100) * tokenCost);

    return result.credit - creditsUsed;
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

    storage += Number(size);
    upload += Number(size);

    console.log('stats', stats);

    let creditNeeded = getCreditNeeded(botType, upload, storage, queries);
    const creditsRemaining = await getCreditsRemaining(userId);

    if (creditsRemaining < creditNeeded) {
        return res.status(402).json({creditNeeded, creditsRemaining});
    }

    result = await redisClient.hSet(userId, 'storage', storage.toString());
    result = await redisClient.hSet(userId, 'upload', upload.toString());

    res.status(200).json('success');
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

const getAvailableCredits = async (req, res) => {
    const { token } = req.body;
    console.log('getAvailableCredits token', token);

    if (!token) return res.status(400).json('bad command');

    const decodedToken = jwtUtil.getToken(token);

    console.log('getAvailableCredits decodedToken', decodedToken);

    const creditsRemaining = await getCreditsRemaining(decodedToken.userId);

    console.log('getAvailableCredits creditsRemaining', creditsRemaining);

    if (creditsRemaining === false) return res.status(401).json('bad command');

    res.status(200).json(creditsRemaining);

}



const purchaseCredits = async (req, res) => {
    url = '/home';

    console.log('req.body', req.body);

    let { userToken, quantity, cost, discount} = req.body;

    if (!userToken || !quantity || !cost || typeof discount === 'undefined') return res.status(400).json('bad request');

    const token = jwtUtil.getToken(userToken);

    console.log('token', token);

    const { userId, userName, email } = token;

    if (isNaN(quantity)) return res.status(400).json('bad request 2');
    if (isNaN(cost)) return res.status(400).json('bad request 3');

    const orderId = uuidv4();

    pendingPurchases[orderId] = res;

    quantity = Math.trunc(Number(quantity));

    console.log ('quantity', quantity);

    const session = await stripe.checkout.sessions.create({
        payment_method_types: [
            'card'
        ],
        mode: 'payment', // 'subscription' would be for recurring charges,
        success_url: `https://app-${SERVER_SERIES}.instantchatbot.net:6250/successfulPurchase?qty=${quantity}&userId=${userId}&orderId=${orderId}`,
        cancel_url: `https://app-${SERVER_SERIES}.instantchatbot.net:6250/failedPurchase?userId=${userId}&orderId=${orderId}`,
        line_items: [
            {
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `Instant Chatbot Credit: ${quantity} Tokens`,
                    },
                    unit_amount: cost
                },
                quantity: 1
            }
        ]
    })

    res.status(200).send(session.url);
    
}

const sendPaymentMessage = async (msg, res, error = true) => {
    if (error) return res.redirect(`https://instantchatbot.net/purchase/?status=error&msg=${encodeURIComponent(msg)}`);

    return res.status(200).redirect(`https://instantchatbot.net/purchase/?status=success&msg=${encodeURIComponent(msg)}`);
}

const handleSuccessfulPurchase = async (req, res) => {
    console.log('handleSuccessfulPurchase', req.query, pendingPurchases);

    const { qty, userId, orderId } = req.query;

    if (!orderId) return sendPaymentMessage('Error: missing orderId', res);
    if (!pendingPurchases[orderId]) return sendPaymentMessage('Error: incorrect orderId', res);
    
    const purchase = pendingPurchases[orderId];

    let request, result;

    // force stats into redis if not already
    result = await getUserStats(userId);

    if (result === false) return sendPaymentMessage('wrong user id', res);


    let credit = Number(result.credit);
    credit += Number(qty);
    console.log('handleSuccessfulPurchase redis set ', userId, credit);

    result = await redisClient.hSet(userId, 'credit', credit.toString());
    
    sendPaymentMessage('Success: Thank you for your purchase.', res, false);
}


handleAdminCommands();

app.post('/ai-query', (req, res) => aiQuery(req, res));
app.post('/addStorage', (req, res) => adminCommands.push({command: 'addStorage', req, res}));
app.post('/availableCredits', (req, res) => getAvailableCredits(req, res));

app.post('/purchaseCredits', (req, res) => purchaseCredits (req,res));
app.get('/successfulPurchase', (req, res) => handleSuccessfulPurchase(req, res));
app.get('/failedPurchase', (req, res) => handleFailedPurchase(req, res));

const httpsServer = https.createServer({
    key: fs.readFileSync(privateKeyPath),
    cert: fs.readFileSync(fullchainPath),
  }, app);
  

  httpsServer.listen(listenPort, '0.0.0.0', () => {
    console.log(`HTTPS Server running on port ${listenPort}`);
});
