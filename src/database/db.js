const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

let db;

function getDb() {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH
      ? path.resolve(process.env.DATABASE_PATH)
      : path.join(process.cwd(), 'data', 'coach.db');

    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info(`Database verbonden: ${dbPath}`);
  }
  return db;
}

module.exports = { getDb };
