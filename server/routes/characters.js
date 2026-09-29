/**
 * /api/characters ルート
 */
import express from 'express';
import path from 'path';
import fs from 'fs';
import { get, run, all } from '../lib/db.js';
import { UPLOADS_DIR } from '../lib/config.js';
import { characterUpload } from '../lib/multer.js';

const router = express.Router();
const MAX_CHARACTERS = 21;

router.get('/', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM characters ORDER BY created_at');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'キャラクター一覧の取得に失敗しました。' });
  }
});

router.post('/', characterUpload.single('image'), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'キャラクター名は必須です。' });
    }
    const count = await get('SELECT COUNT(*) as cnt FROM characters');
    if (count.cnt >= MAX_CHARACTERS) {
      return res.status(400).json({ error: `キャラクターは最大${MAX_CHARACTERS}件までです。` });
    }
    const imagePath = req.file ? path.basename(req.file.path) : null;
    const result = await run(
      'INSERT INTO characters (name, image_path, description) VALUES (?, ?, ?)',
      [name.trim(), imagePath, description || '']
    );
    const newChar = await get('SELECT * FROM characters WHERE id = ?', [result.lastID]);
    res.json(newChar);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'キャラクターの追加に失敗しました。' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    const char = await get('SELECT * FROM characters WHERE id = ?', [id]);
    if (!char) {
      return res.status(404).json({ error: 'キャラクターが見つかりません。' });
    }
    const newName = name !== undefined ? String(name).trim() : char.name;
    const newDesc = description !== undefined ? String(description ?? '') : (char.description ?? '');
    if (!newName) {
      return res.status(400).json({ error: 'キャラクター名は必須です。' });
    }
    await run(
      'UPDATE characters SET name = ?, description = ? WHERE id = ?',
      [newName, newDesc, id]
    );
    const updated = await get('SELECT * FROM characters WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'キャラクターの更新に失敗しました。' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const char = await get('SELECT * FROM characters WHERE id = ?', [id]);
    if (!char) {
      return res.status(404).json({ error: 'キャラクターが見つかりません。' });
    }
    if (char.image_path) {
      const imgPath = path.join(UPLOADS_DIR, 'characters', char.image_path);
      if (fs.existsSync(imgPath)) {
        fs.unlinkSync(imgPath);
      }
    }
    await run('DELETE FROM characters WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'キャラクターの削除に失敗しました。' });
  }
});

export default router;
