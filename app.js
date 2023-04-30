const listenPort = 6250;
const privateKeyPath = `/home/sslkeys/instantchatbot.net.key`;
const fullchainPath = `/home/sslkeys/instantchatbot.net.pem`;

require('dotenv').config();

const express = require('express');
const https = require('https');
const cors = require('cors');
const fs = require('fs');
const fsPromise = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.static('public'));
app.use(express.json({limit: '500mb'})); 
app.use(cors());

app.get('/', (req, res) => {
    res.send('Hello, World!');
});

//app.post('/addBot', (req, res) => addBot(req, res));

const httpsServer = https.createServer({
    key: fs.readFileSync(privateKeyPath),
    cert: fs.readFileSync(fullchainPath),
  }, app);
  

  httpsServer.listen(listenPort, '0.0.0.0', () => {
    console.log(`HTTPS Server running on port ${listenPort}`);
});
