/**
 * 設定・定数・getSetting / setSetting
 */
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { run, get } from './db.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
export const ROOT_DIR = path.resolve(__dirname, '../..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

export const PANEL_SIZE = 512;
export const COMBINED_PANEL_HEIGHT = PANEL_SIZE * 4;

export const DB_DIR = path.join(ROOT_DIR, 'db');
export const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');
export const GENERATED_DIR = path.join(ROOT_DIR, 'generated');
export const OUTPUT_DIR = path.join(ROOT_DIR, 'output');

const dirs = [DB_DIR, UPLOADS_DIR, GENERATED_DIR, OUTPUT_DIR];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const getSetting = async (key) => {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
};

export const setSetting = async (key, value) => {
  await run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
};

/** セリフ用フォント設定（config/serif-font.json）を読む */
export function getSerifFontConfig() {
  const configPath = path.join(ROOT_DIR, 'config', 'serif-font.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const o = JSON.parse(raw);
    if (o && typeof o.name === 'string' && typeof o.path === 'string') return o;
  } catch (e) {
    console.warn('serif-font.json の読み込みに失敗:', e?.message);
  }
  return null;
}
