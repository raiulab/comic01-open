/**
 * generated パス関連（getGeneratedDirForDate, getGeneratedPathForDate）
 */
import path from 'path';
import fs from 'fs';
import { GENERATED_DIR } from './config.js';

/** date (YYYY-MM-DD) に対応する generated のサブディレクトリを返す。generated/年/月 の絶対パス。 */
export function getGeneratedDirForDate(date) {
  if (!date || typeof date !== 'string') return GENERATED_DIR;
  const [y, m] = date.split('-');
  if (!y || !m) return GENERATED_DIR;
  const year = String(y);
  const month = String(m).padStart(2, '0');
  return path.join(GENERATED_DIR, year, month);
}

/** 保存用の絶対パスと、DB・API用の相対パス（generated からの相対、スラッシュ区切り）を返す。 */
export function getGeneratedPathForDate(date, filename) {
  const dir = getGeneratedDirForDate(date);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const absolutePath = path.join(dir, filename);
  let relativePath = path.relative(GENERATED_DIR, absolutePath);
  if (path.sep !== '/') relativePath = relativePath.split(path.sep).join('/');
  return { absolutePath, relativePath };
}
