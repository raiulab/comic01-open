/**
 * シリーズ設定（getConceptConfig, getConceptContext, getEffectiveDrawingStyle, getStrictStyleRules）
 */
import { getSetting } from '../lib/config.js';
import { all } from '../lib/db.js';

/** シリーズ設定（concept_config）をパースして返す。不正な場合は null */
export const getConceptConfig = async () => {
  const raw = await getSetting('concept_config');
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

/** プロンプト用にシリーズ設定の要約テキストを組み立てる */
export const getConceptContext = async () => {
  const c = await getConceptConfig();
  if (!c) return '';
  const parts = [];
  if (c.main_character?.description) parts.push(`主役・世界観: ${c.main_character.description}`);
  if (c.humor_source) parts.push(`面白さの核: ${c.humor_source}`);
  if (c.tone) parts.push(`トーン: ${c.tone}`);
  if (c.art_style) parts.push(`画風: ${c.art_style}`);
  if (c.color) parts.push(`色: ${c.color}`);
  if (c.human_depiction) parts.push(`人間の描き方: ${c.human_depiction}`);
  if (c.characters_note) parts.push(`キャラクター運用: ${c.characters_note}`);
  if (c.extra_characters) parts.push(`サブキャラ: ${c.extra_characters}`);
  if (c.distribution) parts.push(`配信方針: ${c.distribution}`);
  if (c.composition_basis) parts.push(`【構成の基本】${c.composition_basis}`);
  if (c.composition_rules) parts.push(`【構成ルール】${c.composition_rules}`);
  if (parts.length === 0) return '';
  return '\n\n【シリーズ設定】\n' + parts.join('\n');
};

/** 画風文言。concept_config に art_style があればそれを優先、なければ drawing_style */
export const getEffectiveDrawingStyle = async () => {
  const c = await getConceptConfig();
  if (c?.art_style && typeof c.art_style === 'string') return c.art_style.trim();
  const drawingStyle = (await getSetting('drawing_style')) || '';
  if (drawingStyle.trim()) return drawingStyle.trim();
  return 'リアリスティックな3D CG風のコミックスタイル。参照画像に登録した3D CG風画像の画風を厳密に再現すること。';
};

/** 設定に基づく厳守ルール（白黒／画風統一）をプロンプト用文字列で返す */
export const getStrictStyleRules = async (overrideMonochrome = false) => {
  const c = await getConceptConfig();
  const rules = [];
  const useMonochrome = overrideMonochrome || c?.color === '白黒' || c?.color === '白黒のみ';
  if (useMonochrome) {
    rules.push('【厳守】白黒のみで描くこと。カラー・色付けは絶対に禁止。');
  } else {
    if (c?.color) rules.push(`【厳守】色は「${c.color}」のみとすること。`);
    rules.push('【絶対厳守】この画像は必ずフルカラーで描くこと。白黒、グレースケール、モノクロは絶対に禁止。上記の【画風】に従った色使いとライティングを適用すること。');
  }
  rules.push('全てのコマで画風・トーン・線の太さ・質感を完全に同一にすること。');
  rules.push('【厳守】この画像には1コマ分のイラストだけを描くこと。複数のコマを並べた構成、枠で分割した画像、4コマや2コマを1枚にまとめた絵は絶対に描かないこと。1枚の画像に1つのシーンのみ。');
  return rules.join('\n');
};

/** 複数コマを1枚の縦長画像として描く場合の厳守ルール */
export const getStrictStyleRulesForCombined = async (overrideMonochrome = false) => {
  const c = await getConceptConfig();
  const rules = [];
  let panelCount = 4;
  try {
    const s = await getSetting('panel_count');
    const n = parseInt(s, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 10) panelCount = n;
  } catch (_) {}
  const useMonochrome = overrideMonochrome || c?.color === '白黒' || c?.color === '白黒のみ';
  if (useMonochrome) {
    rules.push('【厳守】白黒のみで描くこと。カラー・色付けは絶対に禁止。');
  } else {
    if (c?.color) rules.push(`【厳守】色は「${c.color}」のみとすること。`);
    rules.push('【絶対厳守】この画像は必ずフルカラーで描くこと。白黒、グレースケール、モノクロは絶対に禁止。上記の【画風】に従った色使いとライティングを適用すること。');
  }
  rules.push('全てのコマで画風・トーン・線の太さ・質感を完全に同一にすること。');
  rules.push(`【厳守】1枚の縦長画像に${panelCount}コマを縦に並べること。コマの枠線は手書き風のやや歪んだ線で引き、完璧な直線ではなく引くこと。画像の上端・下端・左右の端まで必ず引くこと。上から1コマ目〜${panelCount}コマ目とする。各コマの縦横比（横長/正方形/縦長）の指定がある場合は、その指定を優先してコマの高さを調整してよい。`);
  return rules.join('\n');
};

/** テキストに名前が登場する登録キャラクターのリストを返す */
export function getCharactersMentionedInText(text, allCharacters) {
  if (!text || typeof text !== 'string' || !Array.isArray(allCharacters) || allCharacters.length === 0) return [];
  const t = text.trim();
  if (!t) return [];
  return allCharacters.filter(c => c.name && t.includes(String(c.name).trim()));
}

/** 概要・構成テキストから登場キャラの属性をプロンプト用文字列で返す */
export async function getCharacterInfoFromSummary(episodeSummary, summaryStr) {
  const allChars = await all('SELECT * FROM characters ORDER BY created_at');
  if (!allChars.length) return '';
  let text = '';
  if (episodeSummary) text += String(episodeSummary);
  if (summaryStr) {
    text += '\n' + summaryStr;
    try {
      const parsed = JSON.parse(summaryStr);
      if (Array.isArray(parsed)) {
        parsed.forEach(p => { if (p.content) text += '\n' + p.content; if (p.description) text += '\n' + p.description; });
      }
    } catch (_) {}
  }
  const mentioned = getCharactersMentionedInText(text, allChars);
  if (mentioned.length === 0) return '';
  return '登場キャラクター（以下の属性を前提にシナリオ・構図を考えてください）:\n' +
    mentioned.map(c => `- ${c.name}: ${c.description || '（属性未設定）'}`).join('\n');
}
