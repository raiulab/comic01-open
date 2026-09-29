/**
 * 画像生成サービス（Gemini/OpenAI、コマ生成、複合コマ、メタデータ保存）
 */
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { getSetting, PANEL_SIZE, COMBINED_PANEL_HEIGHT, GENERATED_DIR, getSerifFontConfig } from '../lib/config.js';
import { getGeneratedPathForDate } from '../lib/paths.js';
import { run, get } from '../lib/db.js';
import { STYLE_REFS_DIR } from '../lib/multer.js';
import { getConceptConfig } from './concept.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT_DIR = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(ROOT_DIR, '.env') });

// 参照画像を軽量化（リサイズ・JPEG圧縮）してAPI送信用のバッファを返す（入力トークン削減で429軽減）
const REF_IMAGE_MAX_PX = 512;
const REF_IMAGE_JPEG_QUALITY = 82;

export async function prepareRefImageForApi(fullPath) {
  try {
    const buf = await sharp(fullPath)
      .resize(REF_IMAGE_MAX_PX, REF_IMAGE_MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: REF_IMAGE_JPEG_QUALITY })
      .toBuffer();
    return { buffer: buf, mimeType: 'image/jpeg' };
  } catch (err) {
    console.warn('参照画像の軽量化に失敗、元ファイルを使用:', fullPath, err.message);
    const raw = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const mimeType = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';
    return { buffer: raw, mimeType };
  }
}

// Gemini helpers
export const getGenAI = () => {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY が設定されていません (.env を確認してください)');
  }
  return new GoogleGenerativeAI(apiKey);
};

export const getTextModel = () => {
  const genAI = getGenAI();
  return genAI.getGenerativeModel(
    { model: 'gemini-3-flash-preview' },
    { apiVersion: 'v1beta' }
  );
};

/** 時代・日付の文脈のキャッシュ。同一日付でテーマ提案→構成生成と続けると二重にAPIを叩くため、短時間キャッシュで1回に抑える。 */
const temporalContextCache = new Map();
const TEMPORAL_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000; // 5分

/**
 * 選択日付の「時代・日付の文脈」をAIで生成する。
 * 同一日付で短時間のうちに再取得する場合はキャッシュを返し、API呼び出しを省略する。
 * @param {string} date - YYYY-MM-DD
 * @returns {Promise<string>} 時代・出来事の短いテキスト。取得失敗時は空文字。
 */
export async function getTemporalContextForDate(date) {
  if (!date || typeof date !== 'string') return '';
  const trimmed = date.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return '';

  const now = Date.now();
  const cached = temporalContextCache.get(trimmed);
  if (cached && cached.expiresAt > now && typeof cached.text === 'string') {
    return cached.text;
  }

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let temporalType;
  if (trimmed < todayStr) temporalType = 'past';
  else if (trimmed > todayStr) temporalType = 'future';
  else temporalType = 'today';

  const dt = new Date(trimmed + 'T12:00:00');
  const year = dt.getFullYear();
  const month = dt.getMonth() + 1;
  const day = dt.getDate();

  const todayLabel = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  let instruction = '';
  if (temporalType === 'past') {
    instruction = `この日付（${year}年${month}月${day}日）は過去の日付です。この時代の世相・代表的なニュースや出来事を2〜5行で簡潔に書いてください。日本での出来事を中心にしつつ、同じ時期の世界（海外）で起きた主な出来事・ニュースも1〜2行含めてよい。`;
  } else if (temporalType === 'today') {
    instruction = `この日付（${year}年${month}月${day}日）は今日または直近です。現在の日本の季節・行事・世相を2〜3行で簡潔に書いてください。この日頃の世界の主なニュース・出来事があれば1行程度追加してよい。`;
  } else {
    instruction = `この日付（${year}年${month}月${day}日）は未来の日付です。この頃にありそうな日本および世界の社会・技術・生活の変化や行事を、推測として2〜5行で簡潔に書いてください。`;
  }

  const prompt = `【重要】今日は${todayLabel}です。この日付を「現在」として、対象日が過去・現在・未来のいずれかを正しく判断してください。

${instruction}
余計な前置きは不要です。本文のみを出力してください。`;

  try {
    const model = getTextModel();
    const result = await model.generateContent(prompt);
    const text = (result?.response?.text() || '').trim();
    temporalContextCache.set(trimmed, { text, expiresAt: now + TEMPORAL_CONTEXT_CACHE_TTL_MS });
    return text;
  } catch (err) {
    console.warn('[getTemporalContextForDate] 時代文脈の取得に失敗しました（フォールバック: 文脈なしで続行）:', err?.message || err);
    return '';
  }
}

// 画像生成用モデル（IMAGE_PROVIDER=gemini 時）
export const getImageModel = () => {
  const genAI = getGenAI();
  const modelName = process.env.IMAGE_MODEL || 'gemini-3-pro-image-preview';
  console.log(`画像生成モデル: ${modelName}`);
  return genAI.getGenerativeModel(
    { model: modelName },
    { apiVersion: 'v1beta' }
  );
};

/** 画像生成プロバイダー: gemini | openai（設定または環境変数 IMAGE_PROVIDER） */
export const getImageProvider = async () => {
  const fromSetting = await getSetting('image_provider');
  const p = (fromSetting || process.env.IMAGE_PROVIDER || 'gemini').toLowerCase();
  return p === 'openai' ? 'openai' : 'gemini';
};

/** Gemini でコマ画像を1枚生成。contents = [画像パーツ..., { text }]。戻り値: Buffer または null。
 * 画像生成は90〜180秒以上かかることがあるため、デフォルトタイムアウトは10分。 */
export async function generatePanelImageWithGemini(contents, options = {}) {
  const { timeout = 600000 } = options;  // 10分（画像生成は長時間かかることがある）
  const imageModel = getImageModel();
  const result = await imageModel.generateContent(contents, { timeout });
  const candidate = result.response.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData);
  if (!imgPart) return null;
  return Buffer.from(imgPart.inlineData.data, 'base64');
}

/** OpenAI DALL-E でコマ画像を1枚生成。参照画像は使わずテキストプロンプトのみ。戻り値: Buffer または null。 */
export async function generatePanelImageWithOpenAI(textPrompt, options = {}) {
  const { size = '1024x1024' } = options;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY が設定されていません。.env に OPENAI_API_KEY を設定するか、IMAGE_PROVIDER=gemini にしてください。');
  }
  const model = process.env.OPENAI_IMAGE_MODEL || 'dall-e-3';
  if (!/^dall-e-(2|3)$/i.test(model)) {
    throw new Error(`OPENAI_IMAGE_MODEL は dall-e-2 または dall-e-3 を指定してください（現在: ${model}）。Gemini用のモデル名を指定していませんか？`);
  }
  try {
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey });
    const response = await client.images.generate({
      model,
      prompt: textPrompt,
      n: 1,
      size,
      response_format: 'b64_json',
      quality: 'standard'
    });
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) return null;
    return Buffer.from(b64, 'base64');
  } catch (apiErr) {
    const msg = apiErr?.message || String(apiErr);
    throw new Error(`OpenAI画像生成APIエラー: ${msg}`);
  }
}

/** 設定のプロバイダーに応じてコマ画像を1枚生成。options.combined が true のときは4コマ縦長1枚。 */
export async function generatePanelImage(contents, textPrompt, options = {}) {
  const { combined = false, combinedTargetHeight, timeout } = options;
  const provider = await getImageProvider();
  let rawBuffer = null;
  if (provider === 'openai') {
    rawBuffer = await generatePanelImageWithOpenAI(textPrompt, { size: combined ? '1024x1792' : '1024x1024' });
  } else {
    rawBuffer = await generatePanelImageWithGemini(contents, { timeout });
  }
  if (!rawBuffer) return null;
  return combined
    ? normalizeCombinedImageBuffer(rawBuffer, { targetHeight: combinedTargetHeight })
    : normalizePanelImageBuffer(rawBuffer);
}

export function normalizeCompositionNotation(content) {
  if (content == null || typeof content !== 'string') return '';
  return content
    .normalize('NFC')
    .replace(/構図([〈《［\[])\s*構図[：:]\s*/g, '$1構図：')
    .replace(/([〈《［\[])\s*構図[：:]\s*構図[：:]\s*/g, '$1構図：');
}

function extractSerifTexts(content) {
  if (!content || typeof content !== 'string') return [];
  const normalized = content
    .replace(/【/g, '[')
    .replace(/】/g, ']')
    .replace(/：/g, ':');
  const texts = [];
  const re = /\[([^\[\]:]+?):([^\[\]]+?)\s*\]/g;
  let match;
  while ((match = re.exec(normalized)) !== null) {
    const text = (match[2] || '').trim();
    if (text) texts.push(text);
  }
  return texts;
}

export function getPromptSafePanelContent(content) {
  const normalizedContent = normalizeCompositionNotation(content);
  const serifTexts = extractSerifTexts(normalizedContent);
  const body = getContentWithoutCompositionMark(normalizedContent)
    .replace(/】\s*【/g, '】\n【')
    .replace(/\]\s*\[/g, ']\n[')
    .replace(/【([^【】：:]+?)[：:]([^【】]+?)\s*】/g, '$2')
    .replace(/\[([^\[\]:]+?):([^\[\]]+?)\s*\]/g, '$2')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return {
    normalizedContent,
    body,
    serifTexts
  };
}

/** content から構図指定を検出。戻り値: 'text_black' | 'text_white' | 'cat_bubble_only' | null */
export function getPanelCompositionType(content) {
  if (!content || typeof content !== 'string') return null;
  const c = normalizeCompositionNotation(content).trim();
  if (/(?:構図)?[〈《［\[]\s*構図[：:]\s*黒地に白字で文字だけ\s*[〉》］\]]/.test(c) || /黒地に白字で文字だけ/.test(c)) return 'text_black';
  if (/(?:構図)?[〈《［\[]\s*構図[：:]\s*白地に黒字で文字だけ\s*[〉》］\]]/.test(c) || /白地に黒字で文字だけ/.test(c)) return 'text_white';
  if (/(?:構図)?[〈《［\[]\s*構図[：:]\s*背景なし[。．]\s*猫のイラストと吹き出しだけ\s*[〉》］\]]/.test(c) || /背景なし[。．]\s*猫のイラストと吹き出しだけ/.test(c)) return 'cat_bubble_only';
  return null;
}

/** content から 〈構図：…〉 / 構図〈構図：…〉 の部分を除いた地の文・ナレーション部分を返す */
export function getContentWithoutCompositionMark(content) {
  if (!content || typeof content !== 'string') return '';
  return normalizeCompositionNotation(content)
    .replace(/(?:構図)?[〈《].*?[〉》]/g, '')
    .replace(/(?:構図)?[［\[]\s*(?:構図[：:])?[^\］\]]*[］\]]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 複数コマ用の画像プロンプト文字列だけを組み立てる（画像は生成しない）。再構築APIで利用。
 * @param {number} [chunkIndex=0] - ストリップ番号（0=1枚目）。6コマ以上で2枚に分かれる場合、2枚目以降の冒頭の文字だけコマには日付を記載しない。
 */
export async function buildCombinedPanelImagePrompt(panelPlans, drawingStyle, strictRules, characterContextForImage = '', compositionRules = '', date = '', chunkIndex = 0) {
  const panelCount = Math.max(1, Math.min((panelPlans && panelPlans.length) ? panelPlans.length : 1, 10));
  const parts = [];
  const aspectLines = [];
  let targetHeight = 0;

  const aspectToRatio = (aspect) => {
    if (aspect === 'landscape') return { label: '横長', w: 4, h: 1 };
    if (aspect === 'portrait') return { label: '縦長', w: 1, h: 4 };
    if (aspect === 'square') return { label: '正方形', w: 1, h: 1 };
    return { label: '正方形', w: 1, h: 1 };
  };

  let formattedDate = '';
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const dt = new Date(date);
    formattedDate = `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
  }

  for (let i = 0; i < panelCount; i++) {
    const plan = panelPlans[i] || { description: `${i + 1}コマ目`, aspect: 'square' };
    const ratio = aspectToRatio(plan.aspect);
    const panelHeight = Math.round(PANEL_SIZE * (ratio.h / ratio.w));
    targetHeight += panelHeight;
    aspectLines.push(`${i + 1}コマ目: ${ratio.label}（目安 ${ratio.w}:${ratio.h}）`);
    const rawDesc = plan.description || plan.content || '';
    const safePanelContent = getPromptSafePanelContent(rawDesc);
    const compType = getPanelCompositionType(safePanelContent.normalizedContent);
    let desc = safePanelContent.body || safePanelContent.normalizedContent;
    const serifInstruction = safePanelContent.serifTexts.length > 0
      ? `\n【吹き出しに入れるセリフ】\n${safePanelContent.serifTexts.map((text) => `- 「${text}」`).join('\n')}`
      : '';
    if (compType === 'text_black') {
      const textBody = safePanelContent.body;
      // 日付は1枚目ストリップの冒頭の文字だけコマにのみ記載。2枚目以降は日付不要（CRITICAL_RULES 参照）
      const shouldAddDate = i === 0 && chunkIndex === 0 && formattedDate && !textBody.includes(formattedDate) && !textBody.includes('年') && !textBody.includes('月') && !textBody.includes('日');
      if (shouldAddDate) {
        desc = `【厳守】このコマはイラストを一切描かず、文字だけのコマにすること。背景は黒一色とし、表示する文字は白で描くこと。表示する文言は以下のみ：「${formattedDate}。${textBody || 'ある日のできごと。'}」`;
      } else {
        desc = `【厳守】このコマはイラストを一切描かず、文字だけのコマにすること。背景は黒一色とし、表示する文字は白で描くこと。表示する文言は以下のみ：「${textBody || '（地の文）'}」`;
      }
    } else if (compType === 'text_white') {
      const textBody = safePanelContent.body;
      const shouldAddDate = i === 0 && chunkIndex === 0 && formattedDate && !textBody.includes(formattedDate) && !textBody.includes('年') && !textBody.includes('月') && !textBody.includes('日');
      if (shouldAddDate) {
        desc = `【厳守】このコマはイラストを一切描かず、文字だけのコマにすること。背景は白一色とし、表示する文字は黒で描くこと。表示する文言は以下のみ：「${formattedDate}。${textBody || 'ある日のできごと。'}」`;
      } else {
        desc = `【厳守】このコマはイラストを一切描かず、文字だけのコマにすること。背景は白一色とし、表示する文字は黒で描くこと。表示する文言は以下のみ：「${textBody || '（地の文）'}」`;
      }
    } else if (compType === 'cat_bubble_only') {
      desc = `【厳守】このコマは背景を描かず、猫のイラストと吹き出し付きのセリフだけを描くこと。背景は無し（白または透明でよい）。猫と吹き出しのみ。\n${safePanelContent.body || '猫と吹き出しのみ。'}${serifInstruction}`;
    } else if (serifInstruction) {
      desc = `${desc}${serifInstruction}`;
    }
    parts.push(`【${i + 1}コマ目】（${ratio.label}）\n${desc}`);
  }

  targetHeight = Math.max(PANEL_SIZE * 2, Math.min(PANEL_SIZE * 10, targetHeight));

  const c = await getConceptConfig();
  const mainCharacterDoesNotSpeak = c?.main_character?.speaks === false;
  let isMonochrome = c?.color === '白黒' || c?.color === '白黒のみ';
  if (!isMonochrome && typeof drawingStyle === 'string' && (drawingStyle.includes('この画風は白黒のみで描くこと') || drawingStyle.includes('【色】白黒'))) {
    isMonochrome = true;
  }
  const colorInstruction = isMonochrome
    ? ''
    : '\n【カラー描画（絶対厳守・最重要）】\n- **必ずフルカラーで描くこと。白黒、グレースケール、モノクロは絶対に禁止。**\n- **上記の【画風】に従った色使いとライティングを適用すること。**\n- **参照画像がある場合は同じカラーパレットと色調を維持すること。**\n- **この指示は最重要です。白黒で描いてはいけません。必ずカラーで描いてください。**\n';

  const styleFromImageStyleConfig = typeof drawingStyle === 'string' && drawingStyle.includes('画風設定');
  const isPolaroidStyle =
    typeof drawingStyle === 'string' &&
    (drawingStyle.includes('polaroid photograph') ||
      drawingStyle.includes('Polaroid photograph') ||
      drawingStyle.includes('polaroid photograph風'));
  const isHolographicStyle =
    typeof drawingStyle === 'string' &&
    (drawingStyle.includes('ホログラフィック風') ||
      drawingStyle.toLowerCase().includes('holographic'));
  const panelCountLabel = panelCount === 1 ? '1コマコミック' : `${panelCount}コマコミック`;
  const panelOrderDescription = panelCount === 1
    ? '1コマ目のみで構成する。'
    : `上から1コマ目・2コマ目・…・${panelCount}コマ目の順に並べる。同一段に複数コマが横並びになる場合は、必ず右から順に小さい番号（例：2と3なら右＝2、左＝3）を並べること。`;
  const serifConfig = getSerifFontConfig();
  const serifBullet = serifConfig?.name
    ? `- **吹き出し内の文字は、${serifConfig.name} のようなゴシック体のサンセリフで、読みやすく統一して描くこと。全コマで同じフォントスタイル（太さ・字間・角の丸み）に揃えること。**\n`
    : '';
  const serifUnifyBlock = serifConfig?.name
    ? `\n【吹き出しの文字（全生成で統一・絶対厳守）】
- **画風・シナリオ・日付・コマの内容に依存せず、吹き出し内の文字は常に「${serifConfig.name}」のようなゴシック体サンセリフで統一すること。** 手書き風・明朝体・丸ゴシック・デザイン書体など別の書体に変えないこと。どの日・どの話・どの画風でも同じ文字スタイルにすること。

`
    : '';
  const imagePromptText = `
${styleFromImageStyleConfig
  ? isPolaroidStyle
    ? '【最優先・絶対厳守】この画像は「polaroid photograph風」の実写・写真スタイルです。以下の【画風】の指示に従い、実際のポラロイド写真のように写実的・写真風に描くこと。参照画像（キャラ参照）は「誰が登場するか・見た目の目安」の参考のみとする。\n\n'
    : isHolographicStyle
    ? '【最優先・絶対厳守】この画像は「ホログラフィック風」のフォトリアル／高品質レンダリングスタイルです。以下の【画風】の指示に従い、実物のホログラフィック素材のような現実的な反射・プリズム効果・光のにじみを写真的に表現すること。参照画像（キャラ参照）は「誰が登場するか・見た目の目安」の参考のみとする。\n\n'
    : '【最優先・絶対厳守】この画像の描画スタイルは、以下の【画風】の指示のみに従うこと。参照画像（キャラ参照）は「誰が登場するか・見た目の目安」の参考のみとする。描画スタイル・タッチ・質感・色調は参照画像に合わせず、必ず【画風】の通りに描くこと。出力が写実的・3D CG風・リアル調になった場合は誤りである。\n\n'
  : ''}
【カラー描画（最重要・最初に確認）】
${isMonochrome ? '【厳守】白黒のみで描くこと。' : '【絶対厳守】この画像は必ずフルカラーで描くこと。白黒、グレースケール、モノクロは絶対に禁止。上記の【画風】に従った色使いとライティングを適用すること。'}

【画風】（厳守）
${drawingStyle}

${strictRules}${colorInstruction}
${serifUnifyBlock}
【コミックの設定】
${panelCountLabel}を1枚の縦長画像で描くこと。${panelOrderDescription}
コマの枠線は手書き風のやや歪んだ線で引き、完璧な直線ではなく引くこと。画像の上端・下端・左右の端まで必ず引くこと。

【コマの配置と読順（絶対厳守・日本の漫画）】
- **【最優先】コマ(panel)もセリフも、必ず右から順に配置すること。** 日本の漫画は右→左・上→下で読む。左から並べることは絶対に禁止。
- **日本の漫画は「右から左」「上から下」で読む。描画時は常に「右から並べる」。** どのようなレイアウト（1段1コマ・1段2コマ・1段3コマなど）でも、**横に並ぶコマは必ず「右に小さい番号・左に大きい番号」**とすること。
- **具体例**: 1コマ目は必ず画像の右側（または上段の右）。2コマ目と3コマ目が同じ段に横並びなら**必ず右＝2コマ目、左＝3コマ目**。1段に3コマ（2・3・4）なら右＝2、中央＝3、左＝4の順。常に右から小さい番号を並べ、左に2コマ目・右に3コマ目のように描くことは絶対に禁止。
- **同じ段に横に2コマ並べる場合：右側＝先に読むコマ（番号が小さい方）、左側＝後に読むコマ（番号が大きい方）。** 例：2と3が横並びなら必ず右＝2コマ目、左＝3コマ目。
- 読者が右→左→上→下の順で読めるよう、**描画時も常に右に「先に読むコマ」を置くこと。**

【画風参照画像について（最重要）】
- 参照画像がある場合、上記の【画風】で描くこと。キャラクターの見た目・構図は参照を参考にしつつ、画風は【画風】の指示に厳密に従うこと
- 全てのコマで同じ画風・タッチ・質感を維持すること
${styleFromImageStyleConfig ? '- **参照画像の画風・タッチをまねないこと。参照は「誰を描くか」のためだけに使い、線の質感・彩色・立体感はすべて【画風】の指示に従うこと。**\n' : ''}

【各コマの比率（厳守）】
${aspectLines.join('\n')}
**重要**: 上記の比率を厳守してください。
- 横長（4:1）のコマ: 高さを小さく（幅の1/4程度）
- 縦長（1:4）のコマ: 高さを大きく（幅の4倍程度）
- 正方形（1:1）のコマ: 高さと幅が同じ（中間の高さ）

各コマの高さの比率は、指定された比率に正確に従ってください。横長のコマは他のコマより明らかに低く、縦長のコマは他のコマより明らかに高く描いてください。

【各コマの内容】
${parts.join('\n\n')}
${characterContextForImage ? `
【登場キャラクターの描画指示（絶対厳守）】
${characterContextForImage}

【キャラクター描画ルール - 必ず遵守すること】
1. 参照画像で渡したキャラクターは、必ず上記の【画風】に従って描くこと
2. キャラクターの外見的特徴（髪型・髪色・服装・体型・顔の特徴・アクセサリー）は参照画像に忠実に維持すること
3. 描画スタイルは上記の【画風】を厳密に再現すること
4. 参照画像をそのままコピーせず、各コマのシーンに合わせてポーズや表情を変えること
5. 同一キャラクターは全コマで外見の一貫性を保つこと（服装・髪型が変わらないこと）
6. キャラクター名や話者名（例：子供A、〇〇）を画像内に文字として絶対に表記しないこと
` : ''}

【人間の描写について（最重要）】
- 人間の風貌や風景など、猫とキャラクター以外はほぼ登場させないこと
- 人間の子供や大人の会話は吹き出しとセリフで表現すること
- 必要に応じて人間がシルエットで登場することがあってもOK
- **人間のシルエットは、立体感をつけず、ただ暗いぼんやりした、輪郭のないシルエットで描くこと。リアルなシルエットや詳細な輪郭、立体感やライティングは避け、平面的でぼやけた暗い影のようなシルエットにすること**
- 人間の詳細な風貌や服装、風景の詳細な描写は避け、猫やキャラクターが中心となるように描くこと

【セリフの扱い（絶対厳守・提案B: セリフ込みで描く）】
- 各コマの説明テキスト内に「【発話者：セリフ内容】」形式でセリフが書かれている場合、**そのセリフを必ず画像内の吹き出しとして描き込むこと。**
- **構成シナリオに書かれたセリフの文字をそのまま描画すること。** ひらがな・カタカナ・アルファベット・数字をその通りに描くこと。漢字は使わないこと。アルファベット（例: "Deux, deux, deux de chat, chat, chat!"）や数字（例: "222"）が含まれる場合も、そのまま正確に描画すること。
- **吹き出し内には「ひと：」「そうべい：」「子供A：」などの話者名を絶対に書かないこと。** セリフ内容のみを描くこと。
- **吹き出しの文字サイズは小さめに、読みやすいサイズで描くこと。**
- **1コマ内にセリフが2つ以上ある場合、必ず右から順に配置すること。** 先に読むセリフ＝右側、後に読むセリフ＝左側。日本の漫画は右から左へ読む。
${serifBullet}- セリフが複数あるコマは、それぞれのセリフが何らかの吹き出しとして画像内に存在すること。
- 吹き出しの形・しっぽは漫画らしく自由に描いてよい（角丸四角、楕円、雲形などバリエーション可）。
- 既に参照画像に文字が含まれている場合も、本編のセリフは上記ルールで新たに描くこと。
${mainCharacterDoesNotSpeak ? '- **主役の黒ねこ（主役の猫）は話さない設定のため、主役の黒ねこからは吹き出しを出さないこと。**\n' : ''}${c?.main_character ? '- **主役の黒ねこ（主役の猫）は1コマに1匹のみ。同じコマに2匹以上描かないこと。**\n' : ''}

【注意】
- キャラクター名・話者名（例：子供A、〇〇、ひと）は画像内に絶対に表記しないこと。吹き出し内には話者名（「ひと：」など）を絶対に書かないこと。
- 1枚の画像の中に${panelCount}コマを縦に並べ、コマ割りの枠を画像サイズいっぱいまで広げること。全コマのイラストが切れずにすべて表示されること
- **【読順・厳守】コマもセリフも必ず右から順に配置すること。** 日本の漫画は右→左・上→下。1コマ目は必ず右側（または上段の右）。2コマ目と3コマ目が横並びのときは必ず右＝2コマ目・左＝3コマ目。セリフも右＝先に読む・左＝後に読む。
- 背景は白またはシンプルに
- 全てのコマで画風を統一すること
${compositionRules ? `\n【構成ルール（シリーズ設定）】\n- ${compositionRules}\n` : ''}
`;
  return imagePromptText;
}

/** 複数コマ（1〜10コマ程度）を1枚の縦長画像として1回だけ生成。 */
export async function generateCombinedPanelImage(panelPlans, drawingStyle, strictRules, contentsBase, characterContextForImage = '', compositionRules = '', date = '', chunkIndex = 0) {
  const imagePromptText = await buildCombinedPanelImagePrompt(panelPlans, drawingStyle, strictRules, characterContextForImage, compositionRules, date, chunkIndex);
  const styleFromImageStyleConfig = typeof drawingStyle === 'string' && drawingStyle.includes('画風設定');
  const contents = styleFromImageStyleConfig
    ? [{ text: imagePromptText }, ...contentsBase]
    : [...contentsBase, { text: imagePromptText }];
  const panelCount = Math.max(1, Math.min((panelPlans && panelPlans.length) ? panelPlans.length : 1, 10));
  const aspectToRatio = (aspect) => {
    if (aspect === 'landscape') return { label: '横長', w: 4, h: 1 };
    if (aspect === 'portrait') return { label: '縦長', w: 1, h: 4 };
    return { label: '正方形', w: 1, h: 1 };
  };
  let targetHeight = 0;
  for (let i = 0; i < panelCount; i++) {
    const plan = panelPlans[i] || { aspect: 'square' };
    const ratio = aspectToRatio(plan.aspect);
    targetHeight += Math.round(PANEL_SIZE * (ratio.h / ratio.w));
  }
  targetHeight = Math.max(PANEL_SIZE * 2, Math.min(PANEL_SIZE * 10, targetHeight));
  return generatePanelImage(contents, imagePromptText, {
    combined: true,
    combinedTargetHeight: targetHeight,
    timeout: 600000  // 複数コマ縦長は生成に時間がかかるため10分
  });
}

/** ストリップ画像（縦に並んだ複数コマ）に対して、指定された panel_number 群のパネル矩形を計算する */
export function getPanelRectsForStrip(imageWidth, imageHeight, stripPanels, summaryStr) {
  if (!stripPanels || stripPanels.length === 0 || !imageWidth || !imageHeight) return [];
  const panelNumbers = [...new Set(stripPanels.map(p => p.panel_number))].sort((a, b) => a - b);
  if (panelNumbers.length === 0) return [];

  let aspectsByPanel = {};
  if (summaryStr && typeof summaryStr === 'string') {
    try {
      const parsed = JSON.parse(summaryStr);
      const arr = Array.isArray(parsed) ? parsed : (parsed?.panels || []);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const num = Number(item.panel);
          if (!num) continue;
          let aspect = item.aspect;
          if (aspect === 'landscape' || aspect === 'portrait' || aspect === 'square') {
          } else {
            aspect = 'square';
          }
          aspectsByPanel[num] = aspect;
        }
      }
    } catch (e) {
      console.warn('summary 解析に失敗しました（パネル矩形は等分割で計算します）:', e.message);
    }
  }

  const aspectToRatio = (aspect) => {
    if (aspect === 'landscape') return { w: 4, h: 1 };
    if (aspect === 'portrait') return { w: 1, h: 4 };
    return { w: 1, h: 1 };
  };

  const ratios = panelNumbers.map(num => {
    const aspect = aspectsByPanel[num] || 'square';
    const r = aspectToRatio(aspect);
    return r.h / r.w;
  });
  const sum = ratios.reduce((s, r) => s + r, 0) || panelNumbers.length;

  const rects = [];
  let currentTop = 0;
  for (let i = 0; i < panelNumbers.length; i++) {
    const num = panelNumbers[i];
    let height;
    if (i === panelNumbers.length - 1) {
      height = imageHeight - currentTop;
    } else {
      height = Math.round(imageHeight * (ratios[i] / sum));
    }
    rects.push({ panel_number: num, top: currentTop, height });
    currentTop += height;
  }
  return rects;
}

/** 生成したコマ画像を PANEL_SIZE x PANEL_SIZE にリサイズして返す */
export async function normalizePanelImageBuffer(buffer) {
  return sharp(buffer)
    .resize(PANEL_SIZE, PANEL_SIZE, { fit: 'cover' })
    .png()
    .toBuffer();
}

/** 4コマ1枚の縦長画像を contain で収め、options.trim が true のときのみ白余白をトリムして返す */
export async function normalizeCombinedImageBuffer(buffer, options = {}) {
  const { trim: doTrim = true, targetHeight } = options;
  const height = Math.max(256, Math.min(8192, Number(targetHeight) || COMBINED_PANEL_HEIGHT));
  const contained = await sharp(buffer)
    .resize(PANEL_SIZE, height, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .png()
    .toBuffer();
  const meta = await sharp(contained).metadata();
  const cw = meta.width || PANEL_SIZE;
  const ch = meta.height || height;
  const top = Math.max(0, Math.round((height - ch) / 2));
  const left = Math.max(0, Math.round((PANEL_SIZE - cw) / 2));
  let composed = await sharp({
    create: {
      width: PANEL_SIZE,
      height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 }
    }
  })
    .composite([{ input: contained, top, left }])
    .png()
    .toBuffer();
  if (doTrim) {
    composed = await sharp(composed).trim({ threshold: 15 }).png().toBuffer();
  }
  return composed;
}

/** 画風参照画像のAPI送信用パーツ（画像を先頭に送ると画風の参考になる） */
export async function getStyleRefImageParts() {
  const refStr = (await getSetting('ref_style_image_path')) || '';
  const files = refStr ? refStr.split(',').map(p => p.trim()).filter(Boolean) : [];
  const parts = [];
  for (const file of files) {
    const fullPath = path.join(STYLE_REFS_DIR, file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const { buffer, mimeType } = await prepareRefImageForApi(fullPath);
      parts.push({ inlineData: { data: buffer.toString('base64'), mimeType } });
    } catch (err) {
      console.warn('画風参照画像の読み込みスキップ:', file, err.message);
    }
  }
  return parts;
}

/** コマの現在画像を Undo 用にバックアップし、バックアップファイル名を返す。画像がなければ null */
export async function savePanelUndoBackup(date, panelNum) {
  const panel = await get('SELECT image_path FROM panels WHERE comic_date = ? AND panel_number = ?', [date, panelNum]);
  if (!panel?.image_path) return null;
  const srcPath = path.join(GENERATED_DIR, panel.image_path);
  if (!fs.existsSync(srcPath)) return null;
  const undoFilename = `${date}-panel-${panelNum}-undo.png`;
  const undoPath = path.join(GENERATED_DIR, undoFilename);
  fs.copyFileSync(srcPath, undoPath);
  return undoFilename;
}

/** 画像生成時に使った画風をメタデータとして保存（ファイル名指定で後から取得するため） */
export async function saveImageGenerationMetadata(imagePath, comicDate, drawingStyle, selectedStyleId, selectedStyleName) {
  if (!imagePath || !drawingStyle) return;
  await run(
    `INSERT INTO image_generation_metadata (image_path, comic_date, drawing_style, selected_style_id, selected_style_name)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(image_path) DO UPDATE SET
       comic_date = excluded.comic_date,
       drawing_style = excluded.drawing_style,
       selected_style_id = excluded.selected_style_id,
       selected_style_name = excluded.selected_style_name`,
    [imagePath, comicDate || null, drawingStyle, selectedStyleId || null, selectedStyleName || null]
  );
}
