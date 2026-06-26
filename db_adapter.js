/**
 * SQLite adapter that emulates the sqlite3 npm package API 
 * but uses sql.js (pure JavaScript / WebAssembly) underneath.
 * This allows server.js to work without compiling native binaries.
 */

const fs = require('fs');
const path = require('path');

let SQL = null;

// Lazy-load sql.js
async function initSqlJs() {
  if (!SQL) {
    const initSqlJs = require('sql.js');
    SQL = await initSqlJs();
  }
  return SQL;
}

class Database {
  constructor(dbPath, callback) {
    this.dbPath = dbPath;
    this._db = null;
    this._ready = false;
    this._queue = [];
    this._saveTimer = null;

    // Initialize asynchronously
    initSqlJs().then(SQL => {
      if (fs.existsSync(dbPath)) {
        const fileBuffer = fs.readFileSync(dbPath);
        this._db = new SQL.Database(fileBuffer);
      } else {
        this._db = new SQL.Database();
      }
      this._ready = true;
      // Process queued operations
      this._queue.forEach(fn => fn());
      this._queue = [];
      if (callback) callback(null);
    }).catch(err => {
      if (callback) callback(err);
    });
  }

  _save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        const data = this._db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(this.dbPath, buffer);
      } catch(e) {
        console.error('DB save error:', e.message);
      }
    }, 100);
  }

  _whenReady(fn) {
    if (this._ready) {
      fn();
    } else {
      this._queue.push(fn);
    }
  }

  // Run a SQL statement (INSERT, UPDATE, DELETE, CREATE)
  run(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    params = params || [];

    this._whenReady(() => {
      try {
        this._db.run(sql, params);
        this._save();
        if (callback) callback.call({ lastID: this._db.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] || 0, changes: 1 }, null);
      } catch(err) {
        if (callback) callback(err);
        else console.error('DB run error:', err.message, '\nSQL:', sql);
      }
    });
    return this;
  }

  // Get a single row
  get(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    params = params || [];

    this._whenReady(() => {
      try {
        const result = this._db.exec(sql, params);
        if (result.length === 0 || result[0].values.length === 0) {
          if (callback) callback(null, undefined);
          return;
        }
        const columns = result[0].columns;
        const values = result[0].values[0];
        const row = {};
        columns.forEach((col, i) => { row[col] = values[i]; });
        if (callback) callback(null, row);
      } catch(err) {
        if (callback) callback(err);
      }
    });
    return this;
  }

  // Get all rows
  all(sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    params = params || [];

    this._whenReady(() => {
      try {
        const result = this._db.exec(sql, params);
        if (result.length === 0) {
          if (callback) callback(null, []);
          return;
        }
        const columns = result[0].columns;
        const rows = result[0].values.map(values => {
          const row = {};
          columns.forEach((col, i) => { row[col] = values[i]; });
          return row;
        });
        if (callback) callback(null, rows);
      } catch(err) {
        if (callback) callback(err, []);
      }
    });
    return this;
  }

  // Serialize - run operations in sequence (they're already synchronous in sql.js)
  serialize(callback) {
    this._whenReady(() => {
      if (callback) callback();
    });
    return this;
  }

  // Close the database
  close(callback) {
    this._whenReady(() => {
      this._save();
      // Wait for save to complete then close
      setTimeout(() => {
        if (this._db) {
          this._db.close();
          this._db = null;
        }
        if (callback) callback(null);
      }, 200);
    });
  }
}

// Emulate sqlite3.verbose() API
module.exports = {
  verbose() {
    return {
      Database
    };
  },
  Database
};
