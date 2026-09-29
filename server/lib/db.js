/**
 * DB 接続・Promise ラッパー（run, get, all）
 */
import path from 'path';
import fs from 'fs';
import sqlite3pkg from 'sqlite3';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT_DIR = path.resolve(__dirname, '../..');
const DB_DIR = path.join(ROOT_DIR, 'db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const dbPath = path.join(DB_DIR, 'raiu_agent.db');
const sqlite3 = sqlite3pkg.verbose();
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      image_path TEXT,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS comics (
      date TEXT PRIMARY KEY,
      theme TEXT,
      episode_summary TEXT,
      summary TEXT,
      status TEXT DEFAULT 'draft',
      ref_images TEXT,
      selected_characters TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('ALTER TABLE comics ADD COLUMN episode_summary TEXT', (err) => {
    if (err && !/duplicate column name/i.test(err.message)) console.error('comics episode_summary:', err.message);
  });
  db.run('ALTER TABLE comics ADD COLUMN background_note TEXT', (err) => {
    if (err && !/duplicate column name/i.test(err.message)) console.error('comics background_note:', err.message);
  });
  db.run(`
    CREATE TABLE IF NOT EXISTS panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comic_date TEXT NOT NULL,
      panel_number INTEGER NOT NULL,
      image_path TEXT,
      status TEXT DEFAULT 'ungenerated',
      UNIQUE(comic_date, panel_number)
    )
  `);
  db.run('ALTER TABLE panels ADD COLUMN previous_image_path TEXT', (err) => {
    if (err && !/duplicate column name/i.test(err.message)) console.error('panels previous_image_path:', err.message);
  });
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      date TEXT PRIMARY KEY,
      topic TEXT,
      generation_mode TEXT DEFAULT 'character',
      tweet_text TEXT,
      image_prompt TEXT,
      image_path TEXT,
      status TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS image_generation_metadata (
      image_path TEXT PRIMARY KEY,
      comic_date TEXT,
      drawing_style TEXT,
      selected_style_id TEXT,
      selected_style_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('panel_count', '4')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('panels_per_file', '4')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('drawing_style', '')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('concept_config', '')`);
});

export const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

export const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

export const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

export { db };
