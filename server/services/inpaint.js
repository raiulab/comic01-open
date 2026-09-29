/**
 * Inpaint（マスク・オーバーレイ・セリフ描画）関連サービス
 */
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { ROOT_DIR, getSerifFontConfig, PANEL_SIZE } from '../lib/config.js';
import { getTextModel } from './imageGeneration.js';

const INPAINT_MASK_ALPHA_THRESHOLD = 20;
const INPAINT_BLEND_FEATHER_PX = 2; // 1→2: 境界の色ずれ・横線アーティファクトを軽減

/** マスク画像の赤塗り領域の bounding box を返す。見つからなければ null。マージンはオプション（px）。 */
export async function getMaskBoundingBox(maskBuffer, marginPx = 8) {
  const { data, info } = await sharp(maskBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const stride = channels || 4;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * stride;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3] ?? 255;
      const isRed = r >= 200 && g <= 100 && b <= 100 && a >= INPAINT_MASK_ALPHA_THRESHOLD;
      if (isRed) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const left = Math.max(0, minX - marginPx);
  const top = Math.max(0, minY - marginPx);
  const right = Math.min(width, maxX + marginPx + 1);
  const bottom = Math.min(height, maxY + marginPx + 1);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top
  };
}

/** Inpaint の「削除」指示かどうか（マスクを白塗りする場合に使う） */
export function isInpaintDeleteInstruction(prompt) {
  const t = String(prompt || '').trim();
  return /^(削除|消す|消して|削除してください|除去|削除して|削除する|消してください)$/i.test(t);
}

/**
 * オーバーレイ/セリフ共通: プロンプトを解析。
 * 先頭の "++" で黒塗り+白文字、なしで白塗り+黒文字。
 * @returns {{ mode: 'delete'|'bracket'|'plain', text: string, useBlackFill: boolean }}
 */
export function parseOverlaySerifInstruction(prompt) {
  let raw = String(prompt || '').trim();
  if (!raw) return { mode: 'plain', text: '', useBlackFill: false };
  // 先頭 "++" で黒塗り+白文字（省略時は白塗り+黒文字）
  let useBlackFill = false;
  if (raw.startsWith('++')) {
    useBlackFill = true;
    raw = raw.slice(2).trim();
    if (!raw) return { mode: 'plain', text: '', useBlackFill: true };
  }
  // 削除: **削除 / ++削除 など
  const deletePattern = /^[*＊]{1,2}\s*(削除|消す|消して|削除してください|除去|削除して|削除する|消してください)$/i;
  if (deletePattern.test(raw)) return { mode: 'delete', text: '', useBlackFill };
  // 「文言」
  const bracketMatch = /^「(.+)」\s*$/.exec(raw);
  if (bracketMatch) return { mode: 'bracket', text: bracketMatch[1].trim(), useBlackFill };
  return { mode: 'plain', text: raw, useBlackFill };
}

/** イラスト修正用: 短いプロンプトを具体的な編集指示に展開する（モデルが指示を通じやすくするため） */
export async function expandIllustrationPrompt(userPrompt, characterContext = '') {
  const t = String(userPrompt || '').trim();
  if (t.length >= 80) return t;
  try {
    const model = getTextModel();
    const result = await model.generateContent(
      `あなたは漫画の画像編集アシスタントです。ユーザーがマスクした領域のイラストを修正したいときの指示を、画像生成AIに渡すための「具体的な編集指示」に展開してください。

【ユーザーの短い指示】
${t}
${characterContext ? `\n【登場キャラクター】\n${characterContext}\n` : ''}

【ルール】
- 60〜150文字程度の具体的な指示に展開すること
- 「何を」「どのように」変えるか明確に書くこと（例: 表情なら「目を細め、口角を上げた笑顔に」）
- ユーザーが服装・髪型・外見の変更を求めている場合は、その変更内容を優先して明確に記述すること（維持は求めない）
- それ以外の編集（表情・ポーズなど）では、マスク外のキャラクターの特徴は維持することを明記すること
- 余計な前置きや説明は不要。編集指示の本文のみを1行で出力すること
- 日本語で出力すること`
    );
    const expanded = (result?.response?.text() || '').trim();
    if (expanded && expanded.length > 0) {
      console.log(`[Inpaint] プロンプト展開: "${t.substring(0, 30)}..." → "${expanded.substring(0, 50)}..."`);
      return expanded;
    }
  } catch (err) {
    console.warn('[expandIllustrationPrompt] 展開失敗、元のプロンプトを使用:', err?.message);
  }
  return t;
}

/**
 * 元パッチから吹き出し背景色をサンプル（明るいピクセル＝吹き出し地の平均色）。
 * 塗りと背景の色差を防ぐため、純白ではなく実際の背景色に合わせる。
 * @param {Buffer} originalPatchBuffer - 元画像のパッチ（RGBA）
 * @returns {{ r: number, g: number, b: number } | null} サンプルできた色、なければ null
 */
export async function sampleBackgroundColorFromPatch(originalPatchBuffer) {
  try {
    const { data, info } = await sharp(originalPatchBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const stride = info.channels || 4;
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    const LUMINANCE_THRESHOLD = 200; // 明るいピクセル＝吹き出し地
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * stride;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3] ?? 255;
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        if (luminance >= LUMINANCE_THRESHOLD && a >= 200) {
          sumR += r;
          sumG += g;
          sumB += b;
          count++;
        }
      }
    }
    if (count < 10) return null;
    return {
      r: Math.round(sumR / count),
      g: Math.round(sumG / count),
      b: Math.round(sumB / count)
    };
  } catch (err) {
    console.warn('[sampleBackgroundColorFromPatch] 失敗:', err?.message);
    return null;
  }
}

/**
 * 指定サイズの塗りつぶしパッチを返す。背景色を指定すればそれを使用、なければ純白。
 * @param {number} width
 * @param {number} height
 * @param {{ r: number, g: number, b: number } | null} [backgroundColor]
 */
export async function createWhitePatchBuffer(width, height, backgroundColor = null) {
  const bg = backgroundColor && typeof backgroundColor.r === 'number' && typeof backgroundColor.g === 'number' && typeof backgroundColor.b === 'number'
    ? { r: backgroundColor.r, g: backgroundColor.g, b: backgroundColor.b, alpha: 1 }
    : { r: 255, g: 255, b: 255, alpha: 1 };
  return sharp({
    create: {
      width: Math.max(1, width),
      height: Math.max(1, height),
      channels: 4,
      background: bg
    }
  })
    .png()
    .toBuffer();
}

/**
 * イラスト修正用: AIの出力パッチをマスクでブレンド。白=AI、黒=元画像。境界は数pxフェザリングで滑らかに。
 * @param {object} [options] - options.featherPx: 境界のぼかし量（0〜8、省略時は INPAINT_BLEND_FEATHER_PX）
 */
export async function blendInpaintPatchWithMask(originalPatchBuffer, aiPatchBuffer, maskBinarizedBuffer, options = {}) {
  const featherPx = typeof options.featherPx === 'number' ? Math.max(0, Math.min(8, options.featherPx)) : INPAINT_BLEND_FEATHER_PX;
  const [origObj, aiObj, maskBinaryObj] = await Promise.all([
    sharp(originalPatchBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(aiPatchBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(maskBinarizedBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  ]);
  const w = origObj.info.width;
  const h = origObj.info.height;

  const maskBinaryGray = Buffer.alloc(w * h);
  const stride = maskBinaryObj.info.channels || 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mi = (y * w + x) * stride;
      maskBinaryGray[y * w + x] = maskBinaryObj.data[mi];
    }
  }

  // sharp.blur() は sigma が 0.3 以上必要。0 のときはぼかしなし（ハードエッジ）
  const maskFeatheredBuf = featherPx <= 0
    ? maskBinaryGray
    : await sharp(maskBinaryGray, { raw: { width: w, height: h, channels: 1 } })
        .blur(Math.max(0.3, featherPx))
        .raw()
        .toBuffer();

  const origData = origObj.data;
  const aiData = aiObj.data;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const mi = y * w + x;
      const alpha = maskFeatheredBuf[mi] / 255;
      out[i] = Math.round(origData[i] * (1 - alpha) + aiData[i] * alpha);
      out[i + 1] = Math.round(origData[i + 1] * (1 - alpha) + aiData[i + 1] * alpha);
      out[i + 2] = Math.round(origData[i + 2] * (1 - alpha) + aiData[i + 2] * alpha);
      out[i + 3] = Math.round(origData[i + 3] * (1 - alpha) + aiData[i + 3] * alpha);
    }
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** マスク画像パッチを二値化する（赤系→白、それ以外→黒）。Inpaint 用。 */
export async function binarizeMaskPatch(maskPatchBuffer) {
  const { data, info } = await sharp(maskPatchBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const stride = channels || 4;
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * stride;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3] ?? 255;
      const isMask = r >= 200 && g <= 100 && b <= 100 && a >= INPAINT_MASK_ALPHA_THRESHOLD;
      const o = (y * width + x) * 3;
      const v = isMask ? 255 : 0;
      out[o] = v;
      out[o + 1] = v;
      out[o + 2] = v;
    }
  }
  return sharp(out, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

/** パッチ画像からテキスト領域の縦方向の有効高さを推定する（セリフ用の粗い指標） */
export async function estimateTextBoxHeight(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const stride = channels || 1;

    const rowDarkCounts = new Array(height).fill(0);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * stride;
        const v = data[i];
        if (v <= 170) rowDarkCounts[y]++;
      }
    }

    const threshold = Math.max(3, Math.floor(width * 0.05));
    let minY = height;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      if (rowDarkCounts[y] >= threshold) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxY < 0) return null;
    return maxY - minY + 1;
  } catch (err) {
    console.warn('estimateTextBoxHeight 失敗:', err.message);
    return null;
  }
}

/**
 * テキストオーバーレイ用: 指定文言を描画した PNG バッファを返す（透明背景・黒文字）。
 * フォントは config/serif-font.json の path で指定した TTF があればそれを使用、なければシステム日本語フォント。
 * @param {string} text - 描画する文言（\n で縦書きは列区切り、横書きは行区切り）
 * @param {number} width - 描画領域幅
 * @param {number} height - 描画領域高さ
 * @param {{ vertical?: boolean, fontSizeScale?: number, textColor?: 'black'|'white' }} options - textColor: 黒文字/白文字（省略時 black）
 */
export async function renderSerifOverlayToBuffer(text, width, height, options = {}) {
  const { vertical = true, fontSizeScale: rawScale, textColor = 'black' } = options;
  const fontSizeScale = typeof rawScale === 'number' ? Math.max(0.5, Math.min(2, rawScale)) : 1;
  const { createCanvas, registerFont } = await import('canvas');
  const serifConfig = getSerifFontConfig();
  const fontPath = serifConfig?.path ? path.join(ROOT_DIR, serifConfig.path) : null;
  const useSerifFont = !!(fontPath && fs.existsSync(fontPath));
  if (useSerifFont) registerFont(fontPath, { family: 'SerifOverlay' });
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  const fontFamily = useSerifFont
    ? 'SerifOverlay'
    : '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic Medium", "Yu Gothic", Meiryo, "MS PGothic", sans-serif';
  ctx.fillStyle = (textColor === 'white') ? '#ffffff' : '#1a1a1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (vertical) {
    const columns = text.split(/\n/).filter(Boolean);
    const numColumns = Math.max(1, columns.length);
    const maxChars = Math.max(1, ...columns.map(col => [...col].length), [...text.replace(/\n/g, '')].length);
    const baseSize = Math.floor(Math.min(width / (numColumns * 1.1), height / (maxChars * 1.2)));
    const fontSize = Math.max(12, Math.round(baseSize * fontSizeScale)); // 8→12: 小さい文字の読みにくさを軽減
    ctx.font = `${fontSize}px ${fontFamily}`;
    const lineHeight = fontSize * 1.35;
    const colWidth = fontSize * 1.2;
    const totalW = numColumns * colWidth;
    const offsetX = Math.max(0, (width - totalW) / 2);
    for (let c = 0; c < columns.length; c++) {
      const chars = [...columns[c]];
      const startX = width - offsetX - (c + 0.5) * colWidth;
      const totalH = chars.length * lineHeight;
      const offsetY = Math.max(0, (height - totalH) / 2);
      for (let i = 0; i < chars.length; i++) {
        const y = offsetY + (i + 0.5) * lineHeight;
        ctx.fillText(chars[i], startX, y);
      }
    }
  } else {
    const lines = text.split(/\n/).filter(Boolean);
    const numLines = Math.max(1, lines.length);
    const maxLineLen = Math.max(1, ...lines.map(l => [...l].length));
    const baseSize = Math.floor(Math.min(width / (maxLineLen * 1.1), height / (numLines * 1.3)));
    const fontSize = Math.max(12, Math.round(baseSize * fontSizeScale));
    ctx.font = `${fontSize}px ${fontFamily}`;
    const lineHeight = fontSize * 1.4;
    const totalH = numLines * lineHeight;
    const offsetY = Math.max(0, (height - totalH) / 2);
    for (let i = 0; i < lines.length; i++) {
      const y = offsetY + (i + 0.5) * lineHeight;
      ctx.fillText(lines[i], width / 2, y);
    }
  }
  return canvas.toBuffer('image/png', { compressionLevel: 6 });
}
