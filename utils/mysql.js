const mysql = require('mysql2');
const mysqlPromise = require('mysql2/promise');

exports.connect = (host, user, password, database, limit = 3) => {
    const db = mysql.createPool({
      connectionLimit : limit, //important
      host, user, password, database,
      debug: false
    });

    db.meta = {
        host, user, database
    }
    return db;
}

exports.query = (db, query) => {
    return new Promise ((resolve, reject) => {
      db.query(query,(err, data) => {
        if(err) {
            console.error(`${query}\nERROR [MYSQL h:${db.meta.host} d:${db.meta.database} u:${db.meta.user}]: ${err.sqlMessage}`);
            return reject(err);
        }
        // rows fetch
        //console.log(data);
        return resolve(data);
    });
    })
  }

  exports.escape = str => mysql.escape(str);