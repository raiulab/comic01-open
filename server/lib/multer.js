/**
 * Multer インスタンス（upload, characterUpload, comicRefUpload, styleRefUpload）
 */
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { UPLOADS_DIR } from './config.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      const timestamp = Date.now();
      const index = req.files ? req.files.length : 0;
      cb(null, `ref_character_${timestamp}_${index}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const characterStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const charDir = path.join(UPLOADS_DIR, 'characters');
    if (!fs.existsSync(charDir)) fs.mkdirSync(charDir, { recursive: true });
    cb(null, charDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `char_${Date.now()}${ext}`);
  }
});
export const characterUpload = multer({
  storage: characterStorage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

const comicRefStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const refDir = path.join(UPLOADS_DIR, 'comic_refs');
    if (!fs.existsSync(refDir)) fs.mkdirSync(refDir, { recursive: true });
    cb(null, refDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const timestamp = Date.now();
    const index = req.files ? req.files.length : 0;
    cb(null, `ref_${timestamp}_${index}${ext}`);
  }
});
export const comicRefUpload = multer({
  storage: comicRefStorage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

export const STYLE_REFS_DIR = path.join(UPLOADS_DIR, 'style_refs');
const styleRefStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(STYLE_REFS_DIR)) fs.mkdirSync(STYLE_REFS_DIR, { recursive: true });
    cb(null, STYLE_REFS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const timestamp = Date.now();
    const index = req.files ? req.files.length : 0;
    cb(null, `style_${timestamp}_${index}${ext}`);
  }
});
export const styleRefUpload = multer({
  storage: styleRefStorage,
  limits: { fileSize: 10 * 1024 * 1024 }
});

// 出力フォルダ保存用（メモリ保存→ルートでファイル書き込み）
export const outputUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!allowedMimes.includes(file.mimetype)) {
      cb(new Error('許可されていないファイル形式です。'));
    } else {
      cb(null, true);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

export { upload };
