require('dotenv').config();
const { getDb } = require('./db');
const logger = require('../utils/logger');

function initDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      frequency TEXT DEFAULT 'daily',
      times_per_day INTEGER DEFAULT 1,
      preferred_periods TEXT,
      earliest_time TEXT,
      latest_time TEXT,
      retry_after_minutes INTEGER DEFAULT 30,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER REFERENCES habits(id),
      period TEXT,
      sent_at DATETIME,
      response TEXT,
      completed INTEGER DEFAULT 0,
      attempt_number INTEGER DEFAULT 1,
      date TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      description TEXT NOT NULL,
      frequency TEXT,
      times_per_week INTEGER,
      week_number INTEGER,
      year INTEGER,
      completed INTEGER DEFAULT 0,
      completed_at DATETIME,
      carried_over INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS friday_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      went_well TEXT,
      was_difficult TEXT,
      grateful_for TEXT,
      summary TEXT,
      week_number INTEGER,
      year INTEGER
    );

    CREATE TABLE IF NOT EXISTS habit_week_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER REFERENCES habits(id),
      week_number INTEGER,
      year INTEGER,
      total_expected INTEGER,
      total_completed INTEGER,
      score_percentage INTEGER,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS conversation_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_type TEXT,
      session_id INTEGER,
      role TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed initial habits if the table is empty
  const { count } = db.prepare('SELECT COUNT(*) as count FROM habits').get();
  if (count === 0) {
    const { initialHabits } = require('../config/habits');
    const insert = db.prepare(`
      INSERT INTO habits
        (name, description, frequency, times_per_day, preferred_periods, earliest_time, latest_time, retry_after_minutes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMany = db.transaction((habits) => {
      for (const h of habits) {
        insert.run(
          h.name,
          h.description,
          h.frequency,
          h.timesPerDay,
          JSON.stringify(h.preferredPeriods),
          h.earliestTime,
          h.latestTime,
          h.retryAfterMinutes
        );
      }
    });
    insertMany(initialHabits);
    logger.info('Initiële gewoonten aangemaakt in de database');
  }

  logger.info('Database schema geïnitialiseerd');
}

// Allow running directly: node src/database/migrations.js
if (require.main === module) {
  initDatabase();
  logger.info('Database setup voltooid');
}

module.exports = { initDatabase };
