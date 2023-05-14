require('dotenv').config();
const jwt = require('jsonwebtoken');

const { JWT_SECRET } = process.env;

exports.extractToken = (info, expiredCheck = false) => {
    // if invalid return false
    try {
        if (!jwt.verify(info, JWT_SECRET)) return {status: false, msg: 'invalid token'};
    } catch (err) {
        if (err.name && err.name === 'TokenExpiredError' && expiredCheck === false) return ({status:true, msg: jwt.decode(info)}) 
        console.error(JSON.stringify(err));
        return {status: false, msg: 'invalid token'}
    }
    const token = jwt.decode(info);

    if (expiredCheck) {
        const curTime = new Date();
        if (token.exp < curTime.getTime()/1000) return {status: false, msg: 'token has expired'};
    }

    return {status: true, msg: token};
}

exports.getToken = (info, expiredCheck = false) => {
    const data = this.extractToken(info, expiredCheck);
    if (!data.status) return false;
    else return data.msg;
}

/*
 * expires (3h, 2d, 1y)
 */
exports.sign = (info, expires = '') => {
    if (expires) return jwt.sign(info, JWT_SECRET, {expiresIn: expires})
    else return jwt.sign(info, JWT_SECRET);
}   