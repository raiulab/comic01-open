import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import { run, get, all } from './lib/db.js';
import {
  getSetting,
  setSetting,
  ROOT_DIR,
  UPLOADS_DIR,
  GENERATED_DIR,
  OUTPUT_DIR,
  PANEL_SIZE,
  COMBINED_PANEL_HEIGHT,
  getSerifFontConfig
} from './lib/config.js';
import { getGeneratedPathForDate } from './lib/paths.js';
import {
  upload,
  characterUpload,
  comicRefUpload,
  styleRefUpload,
  outputUpload,
  STYLE_REFS_DIR
} from './lib/multer.js';
import {
  getConceptConfig,
  getConceptContext,
  getEffectiveDrawingStyle,
  getStrictStyleRules,
  getStrictStyleRulesForCombined,
  getCharactersMentionedInText,
  getCharacterInfoFromSummary
} from './services/concept.js';
import {
  parseImageStyleConfig,
  getSelectedImageStyleObject,
  formatImageStylePrompt,
  hasImageStyleConfigSelected,
  getSelectedImageStyleForComic,
  getEffectiveDrawingStyleForComic
} from './services/imageStyle.js';
import {
  prepareRefImageForApi,
  getTextModel,
  getImageModel,
  getImageProvider,
  generatePanelImage,
  generatePanelImageWithGemini,
  buildCombinedPanelImagePrompt,
  generateCombinedPanelImage,
  getPromptSafePanelContent,
  getPanelRectsForStrip,
  getStyleRefImageParts,
  getTemporalContextForDate,
  saveImageGenerationMetadata,
  savePanelUndoBackup
} from './services/imageGeneration.js';
import { buildSuggestStructurePrompt } from './services/structurePrompt.js';
import {
  getMaskBoundingBox,
  isInpaintDeleteInstruction,
  parseOverlaySerifInstruction,
  expandIllustrationPrompt,
  createWhitePatchBuffer,
  sampleBackgroundColorFromPatch,
  blendInpaintPatchWithMask,
  binarizeMaskPatch,
  renderSerifOverlayToBuffer,
  estimateTextBoxHeight
} from './services/inpaint.js';
import {
  generateThemeText,
  getThemeProvider
} from './services/themeProvider.js';
import charactersRouter from './routes/characters.js';

const app = express();
const PORT = process.env.PORT || 8000;

// Express middleware（Inpaintはマスク画像base64を含むため10MB）
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Static for generated images and uploads (参照画像サムネイル用)
app.use('/generated', express.static(GENERATED_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/uploads/characters', express.static(path.join(UPLOADS_DIR, 'characters')));
app.use('/uploads/comic_refs', express.static(path.join(UPLOADS_DIR, 'comic_refs')));
app.use('/uploads/style_refs', express.static(path.join(UPLOADS_DIR, 'style_refs')));

// Characters API（ルート分割）
app.use('/api/characters', charactersRouter);

// 旧 posts テーブル用（後方互換）
const upsertPost = async (post) => {
  await run(
    `
      INSERT INTO posts (date, topic, generation_mode, tweet_text, image_prompt, image_path, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        topic = excluded.topic,
        generation_mode = excluded.generation_mode,
        tweet_text = excluded.tweet_text,
        image_prompt = excluded.image_prompt,
        image_path = excluded.image_path,
        status = excluded.status
    `,
    [
      post.date,
      post.topic,
      post.generation_mode,
      post.tweet_text,
      post.image_prompt,
      post.image_path,
      post.status
    ]
  );
};

// Routes
// デバッグ用: 利用可能なモデルをリストアップ
app.get('/api/debug/models', async (req, res) => {
  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GOOGLE_API_KEY が設定されていません' });
    }

    // v1beta で利用可能なモデルを取得
    const v1betaResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const v1betaData = await v1betaResponse.json();

    // v1 で利用可能なモデルを取得
    const v1Response = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`);
    const v1Data = await v1Response.json();

    res.json({
      v1beta: {
        models: v1betaData.models?.map(m => ({
          name: m.name,
          displayName: m.displayName,
          supportedGenerationMethods: m.supportedGenerationMethods
        })) || [],
        error: v1betaData.error
      },
      v1: {
        models: v1Data.models?.map(m => ({
          name: m.name,
          displayName: m.displayName,
          supportedGenerationMethods: m.supportedGenerationMethods
        })) || [],
        error: v1Data.error
      }
    });
  } catch (err) {
    console.error('モデルリスト取得エラー:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/posts', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM posts ORDER BY date');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB エラーが発生しました。' });
  }
});

app.get('/api/settings/persona', async (req, res) => {
  try {
    const persona_prompt = (await getSetting('persona_prompt')) || '';
    const ref_image_path = (await getSetting('ref_image_path')) || '';
    // 複数画像対応: カンマ区切りを配列に変換
    const ref_image_paths = ref_image_path ? ref_image_path.split(',') : [];
    res.json({ persona_prompt, ref_image_path, ref_image_paths });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '設定取得に失敗しました。' });
  }
});

app.post(
  '/api/settings/persona',
  upload.array('ref_images', 6), // 最大6枚
  async (req, res) => {
    try {
      const personaPrompt = req.body.persona_prompt || '';
      await setSetting('persona_prompt', personaPrompt);

      if (req.files && req.files.length > 0) {
        const existingStr = await getSetting('ref_image_path');
        const existing = existingStr ? existingStr.split(',').filter(Boolean) : [];
        const newPaths = req.files.map(f => path.basename(f.path));
        const combined = [...existing, ...newPaths].slice(0, 6); // 最大6枚
        await setSetting('ref_image_path', combined.join(','));
      } else if (req.body.keep_existing !== 'true') {
        await setSetting('ref_image_path', '');
      }

      const ref_image_path = await getSetting('ref_image_path');
      const ref_image_paths = ref_image_path ? ref_image_path.split(',') : [];
      res.json({ ok: true, ref_image_paths });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: '設定保存に失敗しました。' });
    }
  }
);

// 参照画像1枚削除（ファイル名指定）
app.delete('/api/settings/persona/ref/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename) {
      return res.status(400).json({ error: 'filename は必須です。' });
    }
    const existingStr = await getSetting('ref_image_path');
    const existing = existingStr ? existingStr.split(',').filter(Boolean) : [];
    const filtered = existing.filter(f => f !== filename);
    await setSetting('ref_image_path', filtered.join(','));
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ ok: true, ref_image_paths: filtered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '参照画像の削除に失敗しました。' });
  }
});

// Topic generation for a single day
app.post('/api/topics/generate_day', async (req, res) => {
  const { date } = req.body || {};
  if (!date) {
    return res.status(400).json({ error: 'date は必須です。' });
  }
  try {
    const model = getTextModel();
    const persona = (await getSetting('persona_prompt')) || '';

    const personaContext = persona
      ? `\n\nキャラクターペルソナ（このペルソナに沿ったトピックを提案してください）:\n${persona}`
      : '';

    const dt = new Date(date);
    const month = dt.getMonth() + 1;
    const year = dt.getFullYear();
    const day = dt.getDate();

    const prompt = `
あなたは日本のX（旧Twitter）運用コンサルタントです。
指定された日について、1件の投稿トピックを日本語で提案してください。

要件:
- 日本の祝日、季節イベント、流行を意識すること${personaContext}
- 出力は JSON のみとし、{"date": "${date}", "topic": "トピックの説明"} の形式にしてください。
- 余計な文章や説明は一切書かないでください。JSON のみ返してください。

対象の日付: ${year}年${month}月${day}日 (${date})
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    // JSON 抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'JSON 形式のトピックを取得できませんでした。' });
    }
    const topicData = JSON.parse(jsonMatch[0]);

    const defaultMode = 'character';
    const sql = `
      INSERT INTO posts (date, topic, generation_mode, status)
      VALUES (?, ?, ?, 'topic_pending')
      ON CONFLICT(date) DO UPDATE SET
        topic = excluded.topic,
        generation_mode = COALESCE(posts.generation_mode, excluded.generation_mode),
        status = 'topic_pending'
    `;

    await run(sql, [topicData.date || date, topicData.topic, defaultMode]);

    const updated = await get('SELECT * FROM posts WHERE date = ?', [date]);
    res.json(updated);
  } catch (err) {
    console.error('単日トピック生成エラー:', err);
    res.status(500).json({ error: 'トピック生成に失敗しました。Gemini API を確認してください。' });
  }
});

// Topic generation for a whole month
app.post('/api/topics/generate', async (req, res) => {
  const { month, year } = req.body || {};
  if (!month || !year) {
    return res.status(400).json({ error: 'month と year は必須です。' });
  }
  try {
    const model = getTextModel();
    const persona = (await getSetting('persona_prompt')) || '';

    const personaContext = persona
      ? `\n\nキャラクターペルソナ（このペルソナに沿ったトピックを提案してください）:\n${persona}`
      : '';

    const prompt = `
あなたは日本のX（旧Twitter）運用コンサルタントです。
指定された月について、毎日1件の投稿トピックを日本語で提案してください。

要件:
- 日本の祝日、季節イベント、流行を意識すること${personaContext}
- 出力は JSON 配列のみとし、各要素は {"date": "YYYY-MM-DD", "topic": "トピックの説明"} の形式にしてください。
- 余計な文章や説明は一切書かないでください。JSON のみ返してください。

対象の年月: ${year}年${month}月
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    // JSON 抽出
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'JSON 形式のトピックを取得できませんでした。' });
    }
    const topics = JSON.parse(jsonMatch[0]);

    const defaultMode = 'character';
    const sql = `
      INSERT INTO posts (date, topic, generation_mode, status)
      VALUES (?, ?, ?, 'topic_pending')
      ON CONFLICT(date) DO UPDATE SET
        topic = excluded.topic,
        generation_mode = COALESCE(posts.generation_mode, excluded.generation_mode),
        status = 'topic_pending'
    `;

    for (const item of topics) {
      await run(sql, [item.date, item.topic, defaultMode]);
    }

    res.json({ ok: true, count: topics.length });
  } catch (err) {
    console.error('トピック生成エラー:', err);
    const errorMessage = err.message || String(err);
    res.status(500).json({
      error: 'トピック生成に失敗しました。Gemini API を確認してください。',
      details: errorMessage
    });
  }
});

// Text + image prompt generation
app.post('/api/posts/generate_text', async (req, res) => {
  const { date, generation_mode } = req.body || {};
  if (!date) {
    return res.status(400).json({ error: 'date は必須です。' });
  }
  try {
    const post = await get('SELECT * FROM posts WHERE date = ?', [date]);
    if (!post || !post.topic) {
      return res.status(400).json({ error: '指定日のトピックが存在しません。' });
    }
    const persona = (await getSetting('persona_prompt')) || '';
    const mode = generation_mode || post.generation_mode || 'character';

    const model = getTextModel();
    const baseInstruction = `
あなたは日本語でX（旧Twitter）の投稿原稿と画像生成プロンプトを作成するAIアシスタントです。

出力フォーマット（必ず JSON のみ）:
{
  "tweet_text": "140文字程度の日本語ツイート文。絵文字は少なめ、ハッシュタグは2〜3個まで。",
  "image_generation_prompt": "画像生成AI向けの日本語プロンプト（構図・表情・背景・雰囲気などを詳細に）"
}

余計な文章や説明は一切書かず、上記 JSON だけを返してください。
`;

    const modeInstruction =
      mode === 'scenery'
        ? `
【重要】今回は「風景 / 情景 / POV モード」です。
- キャラクターを前面に出さず、「場所」「物」「情景」「雰囲気」にフォーカスしてください。
- image_generation_prompt では人物を必須にしないでください（いてもよいが主役ではない）。`
        : `
【重要】今回は「キャラクターモード」です。
- 与えられたペルソナに沿ったキャラクターが主役になるようにしてください。
- image_generation_prompt ではキャラクターの服装・髪型・表情・ポーズなどを具体的に指定してください。
`;

    const prompt = `
${baseInstruction}
${modeInstruction}

ペルソナ（日本語要約）:
${persona || '（未設定の場合は、一般的な日本人VTuber風キャラクターを想定してください）'}

本日のトピック:
${post.topic}
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'JSON 形式の応答を取得できませんでした。' });
    }
    const data = JSON.parse(jsonMatch[0]);

    const updated = {
      date,
      topic: post.topic,
      generation_mode: mode,
      tweet_text: data.tweet_text || '',
      image_prompt: data.image_generation_prompt || '',
      image_path: post.image_path || null,
      status: 'draft_ready'
    };
    await upsertPost(updated);

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'テキスト生成に失敗しました。Gemini API を確認してください。' });
  }
});

// Hybrid image generation logic
app.post('/api/posts/generate_image', async (req, res) => {
  const { date, generation_mode, ref_image_filenames } = req.body || {};
  if (!date) {
    return res.status(400).json({ error: 'date は必須です。' });
  }

  try {
    const post = await get('SELECT * FROM posts WHERE date = ?', [date]);
    if (!post || !post.image_prompt) {
      return res.status(400).json({ error: '指定日の image_prompt が存在しません。' });
    }

    const mode = generation_mode || post.generation_mode || 'character';
    const persona = (await getSetting('persona_prompt')) || '';
    const refImagePathsStr = await getSetting('ref_image_path');
    const refImagePaths = refImagePathsStr ? refImagePathsStr.split(',').map(p => p.trim()).filter(Boolean) : [];

    // 画風設定JSON（登録済みなら厳守。なければ art_style / drawing_style）
    const imageStyleConfigRaw = (await getSetting('image_style_config')) || '';
    const imageStyleSelected = (await getSetting('image_style_selected')) || '';
    const selectedStyle = getSelectedImageStyleObject(imageStyleConfigRaw, imageStyleSelected);
    let stylePromptBlock = '';
    if (selectedStyle) {
      const block = formatImageStylePrompt(selectedStyle);
      stylePromptBlock = block ? '【厳守】設定の「画風設定」で指定した以下の指示を厳密に守ること。\n' + block : '';
    } else {
      const fallbackStyle = await getEffectiveDrawingStyle();
      stylePromptBlock = '【画風】（厳守）\n【厳守】以下の画風（シリーズ設定の art_style またはデフォルト）を厳密に守ること。\n' + fallbackStyle;
    }

    // 画像生成に使う参照画像を指定可能（未指定の場合は全件使用）
    let refToUse = refImagePaths;
    if (ref_image_filenames && Array.isArray(ref_image_filenames) && ref_image_filenames.length > 0) {
      const filtered = refImagePaths.filter(f => ref_image_filenames.includes(f));
      if (filtered.length > 0) refToUse = filtered;
    }

    const model = getImageModel();

    // 画風参照画像を取得
    const styleRefParts = await getStyleRefImageParts();

    // 入力メッセージを組み立て（画風は常に先頭で厳守）
    let baseText = stylePromptBlock + '\n\n';
    // 画風参照画像がある場合は指示を追加
    if (styleRefParts.length > 0) {
      baseText += `【画風参照画像について（最重要）】
- 上記の参照画像（${styleRefParts.length}枚）は、リアリスティックな3D CG風のコミックスタイルの画風参考画像です
- これらの参照画像の3D CG風画風を厳密に再現すること
- 参照画像と同じ3D CG風のレンダリングスタイル、質感、ライティングを維持すること
- 参照画像と同じリアリスティックな質感（肌、髪、服などのマテリアル）を再現すること

`;
    }
    if (mode === 'character' && refToUse.length > 0) {
      // キャラクターモード: 参照画像の画風を強く反映（3D CG風）
      baseText += `
【参照画像の3D CG風画風を厳密に再現してください】

上記の参照画像（${refToUse.length}枚）は、リアリスティックな3D CG風のコミックスタイルです。以下の点を完全に一致させてください：

1. 画風の再現（最重要）：
   - 参照画像と同じ3D CG風のレンダリングスタイル、質感、ライティング
   - 参照画像と同じリアリスティックな質感（肌、髪、服などのマテリアル）
   - 参照画像と同じ色使い、色調、彩度
   - 参照画像と同じ3D CG風のアートスタイルを厳密に維持

2. キャラクターデザインの維持（ただし、ポーズ・表情・構図は変更可）：
   - 参照画像と同じ顔の特徴（ただし表情は生成指示に従う）
   - 参照画像と同じ髪型、髪の色、髪の質感
   - 参照画像と同じ体型、プロポーション
   - 参照画像と同じ服装スタイル、デザイン感覚

3. 技術的な再現：
   - 参照画像と同じ3D CG風の照明の方向、影の付け方
   - 参照画像と同じ背景の描き方（ただし構図は生成指示に従う）
   - 参照画像と同じ3D CG風のレンダリング品質

【重要】ポーズ・表情・構図について：
- 参照画像と同じポーズをコピーするのではなく、生成指示に従って新しいポーズや表情を描いてください
- 参照画像は「キャラクターの見た目と3D CG風の画風」の参考として使用し、ポーズや表情は生成指示に従って自由に変更してください
- 生成指示にポーズや表情の指定がない場合でも、参照画像とは異なる自然なポーズや表情を描いてください

前提ペルソナ:
${persona || '参照画像のキャラクターを基準にしてください。'}

生成指示:
${post.image_prompt}

【最重要】参照画像の3D CG風画風とキャラクターデザイン（顔の特徴、髪型、体型、服装）を維持しながら、ポーズ・表情・構図は生成指示に従って新しいものを描いてください。参照画像をそのままコピーするのではなく、同じキャラクターが異なるポーズや表情で描かれている3D CG風画像を生成してください。
`;
    } else {
      // 風景モード: テキストのみ（3D CG風）
      baseText += `
あなたは高品質な3D CG風の画像を生成するAIです。
出力は画像のみで構いません。

【画風指示】
- リアリスティックな3D CG風のレンダリングスタイルで描くこと
- 参照画像に登録した3D CG風画像の画風を参考にすること（参照画像がある場合）

前提ペルソナ（参考情報）:
${persona || '特定のペルソナが未設定の場合は、指示テキストの内容を優先してください。'}

生成指示（日本語）:
${post.image_prompt}
`;
    }

    const contents = [];

    // 画風参照画像を先頭に追加（画風を認識させるため）
    if (styleRefParts.length > 0) {
      contents.push(...styleRefParts);
      console.log(`画風参照画像 ${styleRefParts.length} 枚を追加`);
    }

    if (mode === 'character') {
      // キャラクターモード: 参照画像（指定分または全件）+ テキスト
      if (refToUse.length === 0) {
        return res
          .status(400)
          .json({ error: 'キャラクターモードには参照画像が必要です。設定画面からアップロードしてください。' });
      }

      // 使用する参照画像を軽量化して送信（リサイズ・JPEG圧縮で入力トークン削減、429軽減）
      const imageParts = [];
      for (const refImageFile of refToUse) {
        const fullRefPath = path.join(UPLOADS_DIR, refImageFile.trim());
        if (!fs.existsSync(fullRefPath)) {
          console.warn(`参照画像が見つかりません: ${fullRefPath}`);
          continue;
        }
        const { buffer, mimeType } = await prepareRefImageForApi(fullRefPath);
        const base64 = buffer.toString('base64');
        imageParts.push({
          inlineData: {
            data: base64,
            mimeType
          }
        });
      }

      if (imageParts.length === 0) {
        return res
          .status(400)
          .json({ error: '有効な参照画像ファイルが見つかりません。再アップロードしてください。' });
      }

      // キャラクター参照画像を追加（画風参照画像の後に）
      contents.push(...imageParts);

      // テキストプロンプトを最後に送信
      contents.push({ text: baseText });

      console.log(`キャラクター参照画像 ${imageParts.length} 枚を軽量化して画像生成`);
    } else {
      // 風景 / POV モード: テキストのみ
      contents.push({ text: baseText });
    }

    // モデルAPI仕様は環境に合わせて調整してください
    const result = await model.generateContent(contents);

    // レスポンスの構造を詳しく確認
    const candidate = result.response.candidates?.[0];
    if (!candidate) {
      console.error('画像生成エラー: candidates が空です', result.response);
      return res.status(500).json({
        error: '画像生成のレスポンスが空です。',
        details: 'candidates が存在しません'
      });
    }

    const parts = candidate.content?.parts || [];
    console.log('レスポンス parts:', JSON.stringify(parts.map(p => ({
      hasInlineData: !!p.inlineData,
      hasText: !!p.text,
      type: p.inlineData ? 'image' : p.text ? 'text' : 'unknown'
    })), null, 2));

    const imgPart = parts.find((p) => p.inlineData) || null;

    if (!imgPart) {
      // テキストレスポンスがある場合は、それがエラーメッセージの可能性
      let textResponse = null;
      try {
        const textPart = parts.find((p) => p.text);
        if (textPart && textPart.text) {
          textResponse = typeof textPart.text === 'string' ? textPart.text : await result.response.text();
        }
      } catch (e) {
        console.warn('テキストレスポンスの取得に失敗:', e);
      }

      console.error('画像生成エラー詳細:', {
        finishReason: candidate.finishReason,
        safetyRatings: candidate.safetyRatings || [],
        textResponse: textResponse,
        partsCount: parts.length,
        partsTypes: parts.map(p => p.inlineData ? 'image' : p.text ? 'text' : 'unknown'),
        modelVersion: result.response.modelVersion
      });

      return res.status(500).json({
        error: '画像データを含むレスポンスを取得できませんでした。',
        details: `終了理由: ${candidate.finishReason}${textResponse ? ` | レスポンス: ${textResponse.substring(0, 200)}` : ''}`,
        note: '画像生成に失敗しました。gemini-3-pro-image-preview の設定を確認してください。'
      });
    }

    const imgBase64 = imgPart.inlineData.data;
    console.log('画像データ取得成功:', {
      dataLength: imgBase64?.length || 0,
      mimeType: imgPart.inlineData.mimeType
    });

    const buffer = Buffer.from(imgBase64, 'base64');
    const filename = `${date}-${Date.now()}.png`;
    const { absolutePath: outPath, relativePath: savedPath } = getGeneratedPathForDate(date, filename);

    console.log('画像保存開始:', { filename, outPath, bufferLength: buffer.length });

    try {
      fs.writeFileSync(outPath, buffer);
      console.log('画像保存成功:', outPath);

      // ファイルが実際に存在するか確認
      if (!fs.existsSync(outPath)) {
        console.error('画像ファイルが保存されていません:', outPath);
        return res.status(500).json({ error: '画像ファイルの保存に失敗しました。' });
      }

      const fileStats = fs.statSync(outPath);
      console.log('保存されたファイル情報:', {
        size: fileStats.size,
        exists: true
      });
    } catch (writeErr) {
      console.error('画像保存エラー:', writeErr);
      return res.status(500).json({ error: '画像ファイルの保存に失敗しました。', details: writeErr.message });
    }

    const updated = {
      date,
      topic: post.topic,
      generation_mode: mode,
      tweet_text: post.tweet_text,
      image_prompt: post.image_prompt,
      image_path: savedPath,
      status: 'image_ready'
    };

    console.log('データベース更新前:', updated);

    try {
      await upsertPost(updated);
      console.log('データベース更新成功');

      // 更新後のデータを確認
      const savedPost = await get('SELECT * FROM posts WHERE date = ?', [date]);
      console.log('保存後のデータ:', savedPost);

      res.json(savedPost || updated);
    } catch (dbErr) {
      console.error('データベース更新エラー:', dbErr);
      return res.status(500).json({ error: 'データベースの更新に失敗しました。', details: dbErr.message });
    }
  } catch (err) {
    console.error('画像生成エラー:', err);

    // 429 エラー（クォータ超過）の詳細処理
    if (err.status === 429) {
      const errorDetails = err.errorDetails || [];
      const quotaFailure = errorDetails.find(d => d['@type']?.includes('QuotaFailure'));
      const retryInfo = errorDetails.find(d => d['@type']?.includes('RetryInfo'));

      let errorMessage = '画像生成のクォータを超過しました。';
      let details = [];

      if (quotaFailure?.violations) {
        const freeTierViolations = quotaFailure.violations.filter(v =>
          v.quotaMetric?.includes('free_tier')
        );
        // 無料枠のリクエスト数が 0 = このモデルは無料プランでは利用不可（コードでは解消不可）
        if (freeTierViolations.length > 0) {
          const modelName = process.env.IMAGE_MODEL || 'gemini-3-pro-image-preview';
          errorMessage = `${modelName} は無料プランでは利用できません（無料枠のリクエスト数が 0 です）。`;
          details.push('このモデルは有料プラン（Google AI Pro など）でのみ利用可能です。');
          details.push('有料プランに加入するか、画像生成は別サービスをご利用ください。');
          details.push('クォータ詳細: https://ai.google.dev/gemini-api/docs/rate-limits');
        } else {
          details.push('リクエスト制限に達しました。しばらく待ってから再試行してください。');
        }
      }

      if (retryInfo?.retryDelay) {
        const retrySeconds = Math.ceil(parseFloat(retryInfo.retryDelay.replace('s', '')));
        details.push(`${retrySeconds}秒後に再試行できます。`);
      }

      return res.status(429).json({
        error: errorMessage,
        details: details.join(' '),
        quotaExceeded: true,
        retryAfter: retryInfo?.retryDelay || null
      });
    }

    // その他のエラー
    const errorMsg = err.message || String(err);
    res.status(500).json({
      error: '画像生成に失敗しました。',
      details: errorMsg,
      note: 'サーバーログを確認してください。'
    });
  }
});

// === Settings API ===

// シリーズ設定サンプルJSONを返す（ファイル読み込み用）
const CONCEPT_EXAMPLE_PATH = path.join(ROOT_DIR, 'config', 'series-concept.example.json');
app.get('/api/settings/concept-example', (req, res) => {
  try {
    if (!fs.existsSync(CONCEPT_EXAMPLE_PATH)) {
      return res.status(404).json({ error: 'サンプルファイルが見つかりません。' });
    }
    const raw = fs.readFileSync(CONCEPT_EXAMPLE_PATH, 'utf8');
    const data = JSON.parse(raw);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'サンプルの読み込みに失敗しました。' });
  }
});

// 画風設定（画像生成用）サンプルJSONを返す
const IMAGE_STYLE_EXAMPLE_PATH = path.join(ROOT_DIR, 'config', 'image-style.example.json');
app.get('/api/settings/image-style-example', (req, res) => {
  try {
    if (!fs.existsSync(IMAGE_STYLE_EXAMPLE_PATH)) {
      return res.status(404).json({ error: 'サンプルファイルが見つかりません。' });
    }
    const raw = fs.readFileSync(IMAGE_STYLE_EXAMPLE_PATH, 'utf8');
    const data = JSON.parse(raw);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '画風設定サンプルの読み込みに失敗しました。' });
  }
});

// 基本設定取得
app.get('/api/settings', async (req, res) => {
  try {
    const panelCount = (await getSetting('panel_count')) || '4';
    const panelsPerFile = (await getSetting('panels_per_file')) || '4';
    const drawingStyle = (await getSetting('drawing_style')) || '';
    const conceptConfig = (await getSetting('concept_config')) || '';
    const refStylePath = (await getSetting('ref_style_image_path')) || '';
    const refStyleImagePaths = refStylePath ? refStylePath.split(',').map(p => p.trim()).filter(Boolean) : [];
    const imageProvider = (await getSetting('image_provider')) || process.env.IMAGE_PROVIDER || 'gemini';
    const themeProvider = (await getSetting('theme_provider')) || process.env.THEME_PROVIDER || 'gemini';
    const outputFormat = (await getSetting('output_format')) || 'separate';
    const imageStyleConfigRaw = (await getSetting('image_style_config')) || '';
    const imageStyleSelected = (await getSetting('image_style_selected')) || '';
    const { list: imageStyleList } = parseImageStyleConfig(imageStyleConfigRaw);
    res.json({
      panel_count: parseInt(panelCount, 10),
      panels_per_file: parseInt(panelsPerFile, 10),
      drawing_style: drawingStyle,
      concept_config: conceptConfig,
      ref_style_image_paths: refStyleImagePaths,
      image_provider: imageProvider === 'openai' ? 'openai' : 'gemini',
      theme_provider: themeProvider === 'perplexity' ? 'perplexity' : 'gemini',
      output_format: outputFormat === 'combined' ? 'combined' : 'separate',
      image_style_config: imageStyleConfigRaw,
      image_style_list: imageStyleList,
      image_style_selected: imageStyleSelected
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '設定の取得に失敗しました。' });
  }
});

// 画風参照画像アップロード（最大6枚）
const MAX_STYLE_REFS = 6;
app.post('/api/settings/style-refs', styleRefUpload.array('images', MAX_STYLE_REFS), async (req, res) => {
  try {
    const existingStr = (await getSetting('ref_style_image_path')) || '';
    const existing = existingStr ? existingStr.split(',').map(p => p.trim()).filter(Boolean) : [];
    const newPaths = (req.files || []).map(f => path.basename(f.path));
    const combined = [...existing, ...newPaths].slice(0, MAX_STYLE_REFS);
    await setSetting('ref_style_image_path', combined.join(','));
    res.json({ ok: true, ref_style_image_paths: combined });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '画風参照画像のアップロードに失敗しました。' });
  }
});

// 画風参照画像1枚削除
app.delete('/api/settings/style-refs/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename) {
      return res.status(400).json({ error: 'filename は必須です。' });
    }
    const existingStr = (await getSetting('ref_style_image_path')) || '';
    const existing = existingStr ? existingStr.split(',').map(p => p.trim()).filter(Boolean) : [];
    const filtered = existing.filter(f => f !== filename);
    await setSetting('ref_style_image_path', filtered.join(','));
    const filePath = path.join(STYLE_REFS_DIR, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ ok: true, ref_style_image_paths: filtered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '画風参照画像の削除に失敗しました。' });
  }
});

// 基本設定保存
app.post('/api/settings', async (req, res) => {
  try {
    const { panel_count, panels_per_file, drawing_style, concept_config, image_provider, theme_provider, output_format, image_style_config, image_style_selected } = req.body;
    if (panel_count !== undefined) {
      const count = Math.max(1, Math.min(10, parseInt(panel_count, 10) || 4));
      await setSetting('panel_count', String(count));
    }
    if (panels_per_file !== undefined) {
      const count = Math.max(1, Math.min(10, parseInt(panels_per_file, 10) || 4));
      await setSetting('panels_per_file', String(count));
    }
    if (drawing_style !== undefined) {
      await setSetting('drawing_style', drawing_style);
    }
    if (concept_config !== undefined) {
      const str = typeof concept_config === 'string' ? concept_config : JSON.stringify(concept_config);
      await setSetting('concept_config', str);
    }
    if (image_provider !== undefined) {
      const p = (image_provider === 'openai') ? 'openai' : 'gemini';
      await setSetting('image_provider', p);
    }
    if (theme_provider !== undefined) {
      const tp = (theme_provider === 'perplexity') ? 'perplexity' : 'gemini';
      await setSetting('theme_provider', tp);
    }
    if (output_format !== undefined) {
      const o = (output_format === 'combined') ? 'combined' : 'separate';
      await setSetting('output_format', o);
    }
    if (image_style_config !== undefined) {
      const str = typeof image_style_config === 'string' ? image_style_config : JSON.stringify(image_style_config);
      await setSetting('image_style_config', str);
    }
    if (image_style_selected !== undefined) {
      await setSetting('image_style_selected', String(image_style_selected).trim());
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '設定の保存に失敗しました。' });
  }
});

// === Comics API ===

// 漫画一覧取得
app.get('/api/comics', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM comics ORDER BY date DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '漫画一覧の取得に失敗しました。' });
  }
});

// 漫画詳細取得（コマ情報含む）
app.get('/api/comics/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic) {
      return res.json({ date, status: 'draft', theme: '', episode_summary: '', summary: '' });
    }
    const panels = await all(
      'SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number',
      [date]
    );
    res.json({ ...comic, panels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '漫画の取得に失敗しました。' });
  }
});

// 指定日の combined 画像生成時に使われたプロンプトを再構築して返す（画像は生成しない）
// ?part=style のときは画風（Style）のテキストだけ返す（漫画データは不要・現在の画風設定を使用）
app.get('/api/comics/:date/reconstructed-prompt', async (req, res) => {
  try {
    const { date } = req.params;
    const part = req.query.part;

    if (part === 'style') {
      const drawingStyle = await getEffectiveDrawingStyleForComic();
      const selectedStyle = await getSelectedImageStyleForComic();
      return res.json({
        ok: true,
        date,
        drawing_style: drawingStyle,
        selected_style: selectedStyle
          ? { name: selectedStyle.name, id: selectedStyle.id, color: selectedStyle.color }
          : null
      });
    }

    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic) {
      return res.status(404).json({ error: '指定日の漫画が見つかりません。' });
    }

    const panelCountSetting = parseInt(await getSetting('panel_count'), 10) || 4;
    const panelsPerFile = parseInt(await getSetting('panels_per_file'), 10) || 4;
    const allChars = await all('SELECT * FROM characters ORDER BY created_at');

    let panelPlans = [];
    const summaryStr = comic.summary || '';
    try {
      const parsed = JSON.parse(summaryStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        panelPlans = parsed.map((item) => ({
          panel: Number(item.panel) || 0,
          description: (item.content != null ? String(item.content) : item.description) || `${item.panel}コマ目`,
          aspect: (() => {
            const a = item.aspect;
            if (a === 'landscape' || a === 'portrait' || a === 'square') return a;
            if (typeof a === 'string' && /^\d+:\d+$/.test(a)) return a;
            return 'square';
          })()
        }));
      }
    } catch (_) {}
    while (panelPlans.length < panelCountSetting) {
      panelPlans.push({
        panel: panelPlans.length + 1,
        description: `${panelPlans.length + 1}コマ目`,
        aspect: 'square'
      });
    }

    const plansChunk = panelPlans.slice(0, Math.min(panelsPerFile, panelCountSetting));
    const drawingStyle = await getEffectiveDrawingStyleForComic();
    const selectedStyleForMonochrome = await getSelectedImageStyleForComic();
    const styleRequiresMonochrome = selectedStyleForMonochrome && (selectedStyleForMonochrome.color === '白黒' || selectedStyleForMonochrome.color === '白黒のみ');
    const strictRules = await getStrictStyleRulesForCombined(styleRequiresMonochrome);
    const conceptConfig = await getConceptConfig();
    const compositionRules = conceptConfig?.composition_rules || '';

    const summaryTextForImage = (comic.episode_summary || '') + '\n' + (comic.summary || '') +
      panelPlans.map(p => p.description || p.content || '').join('\n');
    const mentionedForImage = getCharactersMentionedInText(summaryTextForImage, allChars);
    const charIdsToInclude = new Set();
    mentionedForImage.forEach(c => charIdsToInclude.add(String(c.id)));
    if (comic.selected_characters) {
      comic.selected_characters.split(',').filter(Boolean).forEach(id => charIdsToInclude.add(id.trim()));
    }
    const characterContextForImage = mentionedForImage.length > 0
      ? mentionedForImage.map(c => `- ${c.name}: ${c.description || '（属性未設定）'}`).join('\n')
      : '';

    const prompt = await buildCombinedPanelImagePrompt(plansChunk, drawingStyle, strictRules, characterContextForImage, compositionRules, date);
    res.json({
      ok: true,
      date,
      prompt,
      panel_count: plansChunk.length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'プロンプトの再構築に失敗しました。', details: err.message });
  }
});

// 指定画像を生成したときに使った画風（Style）を返す。?image=1981-05-30-combined-1771132906562.png のようにファイル名を指定。
// この機能追加より前に生成した画像はメタデータがないため 404 になる。
app.get('/api/generated/style', async (req, res) => {
  try {
    let imageKey = (req.query.image || '').trim();
    if (!imageKey) {
      return res.status(400).json({ error: 'クエリ image に画像ファイル名を指定してください。（例: image=1981-05-30-combined-1771132906562.png）' });
    }
    if (!imageKey.endsWith('.png')) imageKey += '.png';
    const basename = path.basename(imageKey);
    const row = await get(
      'SELECT * FROM image_generation_metadata WHERE image_path = ? OR image_path LIKE ?',
      [imageKey, '%/' + basename]
    );
    if (!row) {
      return res.status(404).json({
        error: 'この画像の画風メタデータは記録されていません。',
        hint: '画風の記録は、この機能を追加したあとに生成・再生成した画像から行われます。過去に生成した画像は記録がないため取得できません。'
      });
    }
    res.json({
      ok: true,
      image_path: row.image_path,
      comic_date: row.comic_date,
      drawing_style: row.drawing_style,
      selected_style_id: row.selected_style_id,
      selected_style_name: row.selected_style_name,
      created_at: row.created_at
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '画風の取得に失敗しました。', details: err.message });
  }
});

// 漫画作成・更新
app.post('/api/comics/:date', comicRefUpload.array('ref_images', 10), async (req, res) => {
  try {
    const { date } = req.params;
    const { theme, episode_summary, summary, selected_characters, status } = req.body;

    // デバッグログ: 受信したsummaryを確認
    console.log('[POST /api/comics/:date] 受信データ:', {
      date,
      summaryType: typeof summary,
      summaryLength: summary?.length,
      summaryPreview: summary ? summary.substring(0, 200) : 'undefined/null',
      theme: theme?.substring?.(0, 50),
      episode_summary: episode_summary?.substring?.(0, 50)
    });

    let existingComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    let refImages = existingComic?.ref_images || '';

    if (req.files && req.files.length > 0) {
      const newRefs = req.files.map(f => path.basename(f.path));
      const existing = refImages ? refImages.split(',').filter(Boolean) : [];
      refImages = [...existing, ...newRefs].join(',');
    }

    await run(`
      INSERT INTO comics (date, theme, episode_summary, summary, status, ref_images, selected_characters)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        theme = COALESCE(excluded.theme, comics.theme),
        episode_summary = COALESCE(excluded.episode_summary, comics.episode_summary),
        summary = COALESCE(excluded.summary, comics.summary),
        status = COALESCE(excluded.status, comics.status),
        ref_images = excluded.ref_images,
        selected_characters = COALESCE(excluded.selected_characters, comics.selected_characters)
    `, [
      date,
      theme || existingComic?.theme || '',
      episode_summary !== undefined ? episode_summary : (existingComic?.episode_summary ?? ''),
      summary || existingComic?.summary || '',
      status || existingComic?.status || 'draft',
      refImages,
      selected_characters || existingComic?.selected_characters || ''
    ]);

    const updated = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const panels = await all(
      'SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number',
      [date]
    );

    // デバッグログ: 保存後のデータを確認
    console.log('[POST /api/comics/:date] 保存後のデータ:', {
      summaryType: typeof updated?.summary,
      summaryLength: updated?.summary?.length,
      summaryPreview: updated?.summary ? updated.summary.substring(0, 200) : 'undefined/null',
      panelsCount: panels?.length,
      panelNumbers: panels?.map(p => p.panel_number)
    });

    res.json({ ...updated, panels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '漫画の保存に失敗しました。' });
  }
});

// 追加参照画像の削除
app.delete('/api/comics/:date/ref/:filename', async (req, res) => {
  try {
    const { date, filename } = req.params;
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic) {
      return res.status(404).json({ error: '漫画が見つかりません。' });
    }

    const refs = comic.ref_images ? comic.ref_images.split(',').filter(Boolean) : [];
    const filtered = refs.filter(f => f !== filename);
    await run('UPDATE comics SET ref_images = ? WHERE date = ?', [filtered.join(','), date]);

    const filePath = path.join(UPLOADS_DIR, 'comic_refs', filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ ok: true, ref_images: filtered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '参照画像の削除に失敗しました。' });
  }
});

// 読者向け背景メモの更新（手書き編集用・140文字以内）
app.patch('/api/comics/:date/background', async (req, res) => {
  try {
    const { date } = req.params;
    let { background_note } = req.body || {};
    if (typeof background_note !== 'string') background_note = '';
    const note = background_note.slice(0, 140).trim();
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic) {
      return res.status(404).json({ error: '漫画が見つかりません。' });
    }
    await run('UPDATE comics SET background_note = ? WHERE date = ?', [note, date]);
    const updated = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const panels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    res.json({ ...updated, panels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '背景メモの保存に失敗しました。' });
  }
});

// テーマ・エピソード概要のAI提案（構成は返さない）
app.post('/api/comics/:date/suggest', async (req, res) => {
  try {
    const { date } = req.params;
    const { theme_category = 'auto', theme_region = 'none' } = req.body || {};
    const provider = await getThemeProvider();
    const panelCount = parseInt((await getSetting('panel_count')) || '4', 10);
    const conceptContext = await getConceptContext();

    const registeredChars = await all('SELECT name FROM characters ORDER BY created_at');
    const registeredNames = registeredChars.map(c => c.name).filter(Boolean);
    const allowedNote = registeredNames.length === 0
      ? 'エピソード概要に登場させるキャラクターは「人間の大人」「子供」のみとすること。それ以外（動物・架空の存在など）は登場させないこと。'
      : `エピソード概要に登場させるキャラクターは、人間の大人・子供、および設定で登録したキャラクター（${registeredNames.join('、')}）のみとすること。上記以外のキャラは登場させないこと。`;

    const dt = new Date(date);
    const year = dt.getFullYear();
    const month = dt.getMonth() + 1;
    const day = dt.getDate();

    const temporalContext = await getTemporalContextForDate(date);
    const temporalBlock = temporalContext
      ? `\n【時代・日付の文脈】\n${temporalContext}\n`
      : '';

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const isFutureDate = date.trim() > todayStr;

    // 地域指定のプロンプト（theme_region が none 以外のとき）
    const REGION_PROMPTS = {
      americas: '特に**アメリカ（北米）**の出来事・流行を優先すること。',
      europe: '特に**ヨーロッパ**の出来事・流行を優先すること。',
      china: '特に**中国**の出来事・流行を優先すること。',
      india: '特に**インド**の出来事・流行を優先すること。',
      asia: '特に**東南アジア・朝鮮半島など**（日本・中国・インドを除くアジア）の出来事・流行を優先すること。',
      africa: '特に**アフリカ**の出来事・流行を優先すること。',
      latin_america: '特に**中南米**の出来事・流行を優先すること。',
      middle_east: '特に**中近東**の出来事・流行を優先すること。',
      russia_central_asia: '特に**ロシア・中央アジア・モンゴル**の出来事・流行を優先すること。',
    };
    const regionHint = theme_region && theme_region !== 'none' && REGION_PROMPTS[theme_region]
      ? REGION_PROMPTS[theme_region] + '\n'
      : '';

    let priorityBlock;
    const pastBase = '上記の【時代・日付の文脈】に含まれる情報を反映すること。';
    const futureBase = '上記の【時代・日付の文脈】を参考にしつつ、その頃の世界観に合った「ありそうな話題」を創作すること。';

    if (theme_category === 'auto') {
      if (isFutureDate) {
        priorityBlock = `【テーマ選択の優先順位（未来用・厳守）】
対象日は未来の日付です。その日付付近で生じそうな話題を**予想して創作**すること。以下のような幅広い話題を生み出すこと。
- **希望のある話題**（新しい技術の普及、祝日・行事、人々の願いや目標が叶うような出来事など）
- **現実的に起こりうる事象**（社会の変化、生活の変化、自然や気候にまつわる出来事など）
- **SF的なニュース**（未来的な発明・発見、宇宙や科学の進展、ちょっと不思議なできごとなど）
- **現在への警鐘になる出来事**（環境・格差・習慣など、今の延長線上で起きうる問題や教訓）
${futureBase}`;
      } else {
        priorityBlock = `【テーマ選択の優先順位（厳守）】
テーマは、以下の順で優先して選ぶこと。
1. **その日付に起こった日本国内の重要な出来事**（政治・社会・文化・災害・スポーツなど、その日を象徴する事柄）
2. 1に該当するものが弱い、または似た話題が続く場合 → **その日付に起こった世界各地の重要な出来事**（海外の歴史的出来事・事件・行事など。舞台も海外でよい）
3. 1・2とも該当が弱い場合 → **その日付付近に話題にのぼっていた、意外性のある、あるいは今考えると意味深な事柄**（当時は小さく見えたが後世に意味を持つ話、風俗・流行・世相の一片など）
${pastBase}`;
      }
    } else if (theme_category === 'japan_events') {
      const verb = isFutureDate ? '起こりそうな' : '起こった';
      priorityBlock = `【テーマ選択の条件（厳守）】
テーマは、その日付に**日本国内**で${verb}重要な出来事（政治・社会・文化・災害・スポーツなど）に限定すること。
${pastBase}`;
    } else if (theme_category === 'non_japan_events') {
      const verb = isFutureDate ? '起こりそうな' : '起こった';
      priorityBlock = `【テーマ選択の条件（厳守）】
テーマは、その日付に**日本以外の地域**で${verb}重要な出来事に限定すること。舞台も海外でよい。
${regionHint}${pastBase}`;
    } else if (theme_category === 'japan_trends') {
      const verb = isFutureDate ? '話題になりそうな' : '話題にのぼっていた';
      priorityBlock = `【テーマ選択の条件（厳守）】
テーマは、その日付付近に**日本で**${verb}流行・風俗・世相・文化的な事柄に限定すること。
${pastBase}`;
    } else if (theme_category === 'non_japan_trends') {
      const verb = isFutureDate ? '話題になりそうな' : '話題にのぼっていた';
      priorityBlock = `【テーマ選択の条件（厳守）】
テーマは、その日付付近に**日本以外の地域**で${verb}流行・風俗・世相・文化的な事柄に限定すること。舞台も海外でよい。
${regionHint}${pastBase}`;
    } else {
      if (isFutureDate) {
        priorityBlock = `【テーマ選択の優先順位（未来用・厳守）】
対象日は未来の日付です。その日付付近で生じそうな話題を**予想して創作**すること。
${futureBase}`;
      } else {
        priorityBlock = `【テーマ選択の優先順位（厳守）】
テーマは、日本国内 → 世界各地 → 流行・世相の順で優先して選ぶこと。
${pastBase}`;
      }
    }

    const todayLabel = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
    const prompt = `
【重要】今日は${todayLabel}です。この日付を「現在」として、対象日が過去・現在・未来のいずれかを正しく判断してください。

あなたは${panelCount}コマ漫画のテーマとエピソード概要を提案するAIです。
指定された日付に合った、面白い${panelCount}コマ漫画のアイデアを提案してください。
${temporalBlock}
【マンガの基本設定・トーン】
- 人間の会話が客観的に見ると滑稽であったり、純粋で微笑ましいものである
- 猫やキャラクターたちが、その会話を聞いている、あるいはその日に起きた出来事をその場で直接見聞きしている
- 舞台は日本に限定しない。**海外の街・国が舞台でもよい。** その日付に海外で起こった出来事を、キャラクターたちが現地で直接見聞きしている構成も歓迎する（日本で海外の噂話をするだけではなく、海外舞台で体験する話もOK）
- そういうシンプルな漫画です

【トーンの参考（含めると尚よい）】
天才バカボンやチャップリンのスラップスティックコメディ、星新一・筒井康隆のショートショートのような世界観を参考にすること。不思議な未来感、現実の滑稽さの暗喩、シュールなギャグが含まれていると尚よい。大げさにせず、あくまで「ほっこりした日常」の土台の上に、さりげない違和感・ひねり・オチをのせる程度でよい。

${priorityBlock}

要件:
- 日本の祝日、季節イベント、流行も考慮すること（優先順位の1〜3と組み合わせてよい）
${temporalContext ? '- 上記の【時代・日付の文脈】を踏まえ、その時代らしいニュース・出来事や生活感を反映した、ユニークで生活感のあるシナリオを提案すること。日付が過去の場合は当時の世相を、未来の場合はその頃ありそうな世界観を反映すること。\n' : ''}- **テーマの幅・舞台について**: キャラクターは時空を行き来する設定のため、2の場合は**海外が舞台**でもよい。「日本で海外の噂話をしている」だけでなく、**その日付に海外で起こった出来事を現地で直接見聞きしている**構成を提案してよい。
- 「テーマ」は一言で（例: 初詣の失敗）
- 「episode_summary」は${panelCount}コマのストーリー全体の短い概要（2〜4文程度）。起承転結の流れが分かるように書く
- 【厳守】${allowedNote}
- 【厳守】登場する人間（大人や子供たち）は、登録済みキャラクターの名前を呼ばないこと。人間とキャラクター（動物や神さま、精霊など）は別の次元で暮らしているため。子どもとキャラクターたちは近い領域に存在するが、言葉を交わし合うことはない。${conceptContext}

出力は JSON のみとし、以下の形式にしてください:
{
  "theme": "テーマ（一言）",
  "episode_summary": "エピソードの概要（2〜4文で、4コマの流れが分かるように）"
}

対象日: ${year}年${month}月${day}日
`;

    const text = await generateThemeText(prompt, provider);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'AI提案の取得に失敗しました。' });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const theme = parsed.theme || '';
    const episode_summary = parsed.episode_summary || '';

    res.json({ theme, episode_summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'テーマ・エピソード概要の提案に失敗しました。' });
  }
});

// テーマ・エピソード概要から4コマ構成をAIで生成
app.post('/api/comics/:date/suggest_structure', async (req, res) => {
  try {
    const { date } = req.params;
    const { theme, episode_summary } = req.body;
    const model = getTextModel();
    const panelCount = parseInt((await getSetting('panel_count')) || '4', 10);
    const conceptContext = await getConceptContext();

    if (!theme && !episode_summary) {
      return res.status(400).json({ error: 'テーマまたはエピソード概要を入力してください。' });
    }

    const characterInfoFromSummary = await getCharacterInfoFromSummary(episode_summary || '', '');
    const characterBlock = characterInfoFromSummary ? `\n\n${characterInfoFromSummary}` : '';
    const conceptConfigForStructure = await getConceptConfig();

    const dt = new Date(date);
    const year = dt.getFullYear();
    const month = dt.getMonth() + 1;
    const day = dt.getDate();
    const temporalContext = await getTemporalContextForDate(date);
    const today = new Date();
    const todayLabel = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
    const dateContextBlock = temporalContext
      ? `【重要】今日は${todayLabel}です。この日付を「現在」として、対象日が過去・現在・未来のいずれかを正しく判断してください。

【対象日と時代・日付の文脈】\n対象日: ${year}年${month}月${day}日\n時代・日付の文脈: ${temporalContext}\n\n`
      : `【重要】今日は${todayLabel}です。この日付を「現在」として、対象日が過去・現在・未来のいずれかを正しく判断してください。

【対象日】\n${year}年${month}月${day}日\n\n`;

    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const isFutureDate = (date && /^\d{4}-\d{2}-\d{2}$/.test(date.trim()) && date.trim() > todayStr);
    const futureDateInstruction = isFutureDate
      ? '対象日は未来の日付です。構成には、希望を感じさせる要素か、20世紀の文化の何かを懐かしむ要素を加えること。明るい未来への思いや、昔懐かしいもの・習慣・雰囲気への言及や情景を、会話や状況に盛り込むこと。\n\n'
      : '';

    let stageFacilitiesBlock = '';
    if (isFutureDate) {
      const conceptConfig = await getConceptConfig();
      const facilities = conceptConfig?.stage?.facilities;
      if (Array.isArray(facilities) && facilities.length > 0) {
        const facilityList = facilities.map(f => {
          const name = f.name || '';
          const nameShort = f.name_short ? `（${f.name_short}）` : '';
          const note = f.note ? `: ${f.note}` : '';
          return `- ${name}${nameShort}${note}`;
        }).join('\n');
        stageFacilitiesBlock = `【未来の街・施設（参考）】\n以下の施設や場所が、この世界に存在する。構成シナリオに、これらの施設や場所がたまに登場するようにすること。無理に登場させなくてもよいが、自然な流れで言及や情景に含めるとよい。\n${facilityList}\n\n`;
      }
    }

    const prompt = buildSuggestStructurePrompt({
      panelCount,
      theme,
      episodeSummary: episode_summary,
      conceptContext,
      dateContextBlock,
      futureDateInstruction,
      stageFacilitiesBlock,
      temporalContext,
      characterBlock,
      year,
      month,
      day,
      conceptConfigForStructure
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: '構成の取得に失敗しました。' });
    }

    const parsed = JSON.parse(jsonMatch[0]);
    let panels = Array.isArray(parsed.panels) ? parsed.panels : [];

    const resultPanels = [];
    for (let i = 1; i <= panelCount; i++) {
      const item = panels.find(p => Number(p.panel) === i);
      const content = (item && (item.content || item.description)) ? String(item.content || item.description).trim() : '';
      // アスペクト比の検証（3択のみ）
      let aspect = item?.aspect;
      if (aspect === 'landscape' || aspect === 'portrait' || aspect === 'square') {
        // 有効な値はそのまま
      } else {
        aspect = 'square'; // フォールバック
      }
      resultPanels.push({ panel: i, content, aspect });
    }

    res.json({ panels: resultPanels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '構成の提案に失敗しました。' });
  }
});

// === Comic Generation API ===

// 漫画生成（全コマ一括）
app.post('/api/comics/:date/generate', async (req, res) => {
  const { date } = req.params;
  const { panel_count, output_format } = req.body;

  try {
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic || !comic.theme) {
      return res.status(400).json({ error: 'テーマが設定されていません。' });
    }

    const panelCountSetting = panel_count || parseInt(await getSetting('panel_count'), 10) || 4;
    const drawingStyle = await getEffectiveDrawingStyleForComic();
    const selectedStyleForMonochrome = await getSelectedImageStyleForComic();
    const styleRequiresMonochrome = selectedStyleForMonochrome && (selectedStyleForMonochrome.color === '白黒' || selectedStyleForMonochrome.color === '白黒のみ');

    // 画像生成が OpenAI の場合は事前に設定を検証（.env の指定ミスで途中失敗しないように）
    const imageProvider = await getImageProvider();
    if (imageProvider === 'openai') {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(400).json({
          error: '画像生成に OpenAI を指定していますが、OPENAI_API_KEY が設定されていません。.env に OPENAI_API_KEY を設定するか、設定画面で画像プロバイダーを「Gemini」にしてください。'
        });
      }
      const openaiModel = process.env.OPENAI_IMAGE_MODEL || 'dall-e-3';
      if (!/^dall-e-(2|3)$/i.test(openaiModel)) {
        return res.status(400).json({
          error: `OPENAI_IMAGE_MODEL は dall-e-2 または dall-e-3 を指定してください（現在: ${openaiModel}）。Gemini 用のモデル名を .env に指定していませんか？`
        });
      }
    }

    // 準備で指定した構成（summary）をコマ番号と1:1で使用。1コマ目の指示→1コマ目画像、2コマ目→2コマ目…とする。
    const allChars = await all('SELECT * FROM characters ORDER BY created_at');
    let panelPlans = [];
    const summaryStr = comic.summary || '';
    try {
      const parsed = JSON.parse(summaryStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        panelPlans = parsed.map((item) => ({
          panel: Number(item.panel) || 0,
          description: (item.content != null ? String(item.content) : item.description) || `${item.panel}コマ目`,
          aspect: (() => {
            const a = item.aspect;
            if (a === 'landscape' || a === 'portrait' || a === 'square') return a;
            if (typeof a === 'string' && /^\d+:\d+$/.test(a)) return a;
            return 'square';
          })()
        }));
      }
    } catch (_) {}
    if (panelPlans.length === 0) {
      const charIds = comic.selected_characters ? comic.selected_characters.split(',').map(s => String(s).trim()).filter(Boolean) : [];
      let summaryText = (comic.episode_summary || '') + '\n' + (comic.summary || '');
      try {
        const parsed = JSON.parse(comic.summary || '[]');
        if (Array.isArray(parsed)) parsed.forEach(p => { if (p.content) summaryText += '\n' + p.content; if (p.description) summaryText += '\n' + p.description; });
      } catch (_) {}
      const mentioned = getCharactersMentionedInText(summaryText, allChars);
      const mergedIds = new Set(charIds);
      mentioned.forEach(c => mergedIds.add(String(c.id)));
      let characterInfo = '';
      if (mergedIds.size > 0) {
        const placeholders = [...mergedIds].map(() => '?').join(',');
        const chars = await all(`SELECT * FROM characters WHERE id IN (${placeholders})`, [...mergedIds]);
        characterInfo = chars.map(c => `- ${c.name}: ${c.description || '説明なし'}`).join('\n');
      }
      characterInfo = characterInfo ? '\n登場キャラクター（以下の属性を前提に描写してください）:\n' + characterInfo : '';
      const conceptConfigForPanelPlan = await getConceptConfig();
      const textModel = getTextModel();
      const panelPlanPrompt = `
あなたは4コマ漫画のシナリオライターです。
以下のテーマと構成から、${panelCountSetting}コマ漫画の各コマの内容を具体的に決めてください。

【マンガの基本設定・トーン】
- 人間の会話が客観的に見ると滑稽であったり、純粋で微笑ましいものである
- 猫やキャラクターたちが、その会話を聞いている、あるいはその日に起きた出来事をその場で直接見聞きしている。舞台は日本・海外どちらでもよい
- そういうシンプルな漫画です
${conceptConfigForPanelPlan?.main_character ? '- 主役の黒ねこ（主役の猫）は1コマに1匹のみ。同一コマに2匹描写しないこと。\n' : ''}

テーマ: ${comic.theme}
構成: ${summaryStr || '特になし'}${characterInfo}

【人間の描写について（最重要）】
- 人間の風貌や風景など、猫とキャラクター以外はほぼ登場させないこと
- 人間の子供や大人の会話は吹き出しとセリフのみで表現すること
- 必要に応じて人間がシルエットで登場することがあってもOK
- **人間のシルエットは、立体感をつけず、ただ暗いぼんやりした、輪郭のないシルエットで描くこと。リアルなシルエットや詳細な輪郭、立体感やライティングは避け、平面的でぼやけた暗い影のようなシルエットにすること**
- シーン説明では、人間の詳細な風貌や服装、風景の詳細な描写は避け、猫やキャラクターが中心となるようにすること

各コマについて、以下を含む具体的な描写を日本語で書いてください:
- 構図
- キャラクターの配置とポーズ
- 表情
- セリフ（吹き出し内のテキスト。長めの場合は描画時に文字サイズを下げて収めるため、必要な長さでよい）

出力形式（JSON配列）:
[
  {"panel": 1, "description": "1コマ目の詳細な描写..."},
  {"panel": 2, "description": "2コマ目の詳細な描写..."},
  ...
]

JSON配列のみを返してください。
`;
      const planResult = await textModel.generateContent(panelPlanPrompt);
      const planText = planResult.response.text();
      const planMatch = planText.match(/\[[\s\S]*\]/);
      if (!planMatch) {
        return res.status(500).json({ error: 'コマ割りの生成に失敗しました。' });
      }
      panelPlans = JSON.parse(planMatch[0]);
    }

    // 画風参照はループ外で1回だけ取得。画風設定（JSON）でスタイル選択中は送らない（テキストの画風を最優先するため）
    const styleRefParts = await getStyleRefImageParts();
    const contentsBase = [];
    const useImageStyleConfig = await hasImageStyleConfigSelected();
    if (styleRefParts.length > 0 && !useImageStyleConfig) contentsBase.push(...styleRefParts);
    if (useImageStyleConfig) console.log('[まんが生成] 画風設定（JSON）が選択されているため、画風参照画像は送らずテキストの画風を厳守します');

    const MAX_RETRIES = 3;
    const strictRulesCombined = await getStrictStyleRulesForCombined(styleRequiresMonochrome);
    const panelsPerFile = parseInt(await getSetting('panels_per_file'), 10) || 4;
    const conceptConfigForGenerate = await getConceptConfig();
    const compositionRulesForGenerate = conceptConfigForGenerate?.composition_rules || '';

    // panelPlans をコマ数分にそろえる（不足分はデフォルトで埋める）
    while (panelPlans.length < panelCountSetting) {
      panelPlans.push({
        panel: panelPlans.length + 1,
        description: `${panelPlans.length + 1}コマ目`,
        aspect: 'square'
      });
    }

    // 読者向け背景メモ（140文字以内・出来事＋豆知識）をAIで生成（失敗しても本流は続行）
    // 日付ゾーン判定: AIモデルの知識カットオフを考慮し、前後15ヶ月で3ゾーンに分類。
    //   past:        date < today-15M     → モデルが知っている過去（事実ベース）
    //   nearPresent: today-15M <= date <= today+15M → モデルの知識外〜近い未来（暦・記念日・季節限定）
    //   farFuture:   date > today+15M     → 明確な未来（SF的予測OK）
    try {
      const textModel = getTextModel();
      const [y, m, d] = date.split('-').map(Number);
      const todayForNote = new Date();
      const todayStrForNote = `${todayForNote.getFullYear()}-${String(todayForNote.getMonth() + 1).padStart(2, '0')}-${String(todayForNote.getDate()).padStart(2, '0')}`;
      const todayLabelForNote = `${todayForNote.getFullYear()}年${todayForNote.getMonth() + 1}月${todayForNote.getDate()}日`;

      const CUTOFF_MONTHS = 15;
      const knownPastDate = new Date(todayForNote);
      knownPastDate.setMonth(knownPastDate.getMonth() - CUTOFF_MONTHS);
      const knownPastStr = `${knownPastDate.getFullYear()}-${String(knownPastDate.getMonth() + 1).padStart(2, '0')}-${String(knownPastDate.getDate()).padStart(2, '0')}`;

      const farFutureDate = new Date(todayForNote);
      farFutureDate.setMonth(farFutureDate.getMonth() + CUTOFF_MONTHS);
      const farFutureStr = `${farFutureDate.getFullYear()}-${String(farFutureDate.getMonth() + 1).padStart(2, '0')}-${String(farFutureDate.getDate()).padStart(2, '0')}`;

      let noteZone;
      if (date < knownPastStr) {
        noteZone = 'past';
      } else if (date > farFutureStr) {
        noteZone = 'farFuture';
      } else {
        noteZone = 'nearPresent';
      }
      console.log(`[背景メモ] 日付=${date}, knownPast=${knownPastStr}, farFuture=${farFutureStr}, zone=${noteZone}`);

      const dateFormatRule = noteZone === 'farFuture'
        ? '日付の導入は「〇〇年×月△日は、〜です。」の形式にすること。「未来です。」などの語句は絶対に使わないこと。'
        : noteZone === 'past'
          ? '日付の導入は「〇〇年×月△日は、〜でした。」の形式にすること。「過去です。」「現在です。」などの語句は絶対に使わないこと。'
          : '日付の導入は「〇〇年×月△日は、〜です。」の形式にすること。「現在です。」などの語句は絶対に使わないこと。';

      const themeLabel = (comic.theme || '').trim() || '（未設定）';
      const episodeLabel = (comic.episode_summary || '').trim() || '（なし）';

      let prompt;
      if (noteZone === 'farFuture') {
        prompt = `【重要】今日は${todayLabelForNote}です。対象日は未来の日付です。

あなたは、指定された**未来の日付**の「その日の出来事」と「豆知識」を、読者向けにまとめる担当です。SF小説のように、未来の出来事を既成事実として創作し、フィクション・エンターテイメントとして読めるメモにしてください。
日付: ${y}年${m}月${d}日（未来）
テーマ: ${themeLabel}
エピソード概要: ${episodeLabel}

上記の未来の日付に「起こったこと」「その頃の世の中の様子」を、あたかも既に起きた事実であるように創作し、140文字以内の日本語でまとめてください。
- **その日の出来事・事件・社会の様子**（技術の普及、新しい習慣、行事、世界の変化など）を1〜2文で、客観的な事実のように書く。
- その時代の**豆知識**を1つ加えること。例：「この年から〜が義務化されました。」「当時は〜が普及していました。」など、読者が「へえ」と思うような未来の「事実」を1文で。豆知識を書く際は「豆知識として」という前置きは使わず、その内容だけを直接書くこと（例：「この「猫の日」は1987年に愛猫家グループによって制定されました。」）。
【厳守】
- 「現在です」「過去です」「未来です」などの語句は絶対に使わないこと。${dateFormatRule}
- 「〇〇年代の現在では」「2020年代の現在では」など、生成時点の「現在」に関する話題は一切書かないこと。
- 漫画の内容（黒ねこやキャラクター、情景の描写）や、制作者の意図は書かないこと。
- 文末は「〜しました。」「〜でした。」など、簡潔に終えること。
余計な前置きやJSONは不要。説明文のみ返すこと。`;
      } else if (noteZone === 'nearPresent') {
        prompt = `【重要】今日は${todayLabelForNote}です。

あなたは、指定された日付の「暦・記念日・季節」を読者向けにまとめる担当です。
日付: ${y}年${m}月${d}日
テーマ: ${themeLabel}
エピソード概要: ${episodeLabel}

上記の日付にまつわる内容を、140文字以内の日本語でまとめてください。
- **暦の情報**（二十四節気、季節の移り変わりなど）を簡潔に書く。
- **記念日・祝日**（この日が何の日か。例：「猫の日」「建国記念の日」など）があれば書く。
- **季節の風物詩**（旬の食べ物、花、行事など）を1つ加えてよい。
- テーマやエピソード概要がある場合は、それに関連する暦・記念日・季節の情報を優先的に盛り込むこと。
【厳守】
- **技術の普及・社会の変化・ニュース・事件など、特定の年に依存する出来事は一切書かないこと。** 例：「自動運転タクシーが普及」「AIが一般家庭に浸透」などは禁止。
- 暦・記念日・季節の風物詩など、**毎年繰り返される普遍的な事実**だけを書くこと。
- 「現在です」「過去です」「未来です」などの語句は絶対に使わないこと。${dateFormatRule}
- 漫画の内容（黒ねこやキャラクター、情景の描写）や、制作者の意図は書かないこと。
- 文末は「〜です。」「〜でした。」など、簡潔に終えること。
余計な前置きやJSONは不要。説明文のみ返すこと。`;
      } else {
        prompt = `【重要】今日は${todayLabelForNote}です。対象日は過去の日付です。

あなたは、指定された日付の「その日の出来事」と「豆知識」を読者向けにまとめる担当です。
日付: ${y}年${m}月${d}日
テーマ: ${themeLabel}
エピソード概要: ${episodeLabel}

上記の日付（またはその前後の時期）にまつわる内容を、140文字以内の日本語でまとめてください。
- **その日の事件・出来事・季節感**（日本だけでなく世界のどこかで起きたことでも可）を客観的に1〜2文で書く。
- その時代の**豆知識**を1つ加えること。例：「当時アイスクリームはアイスクリンと呼ばれていました。」「この年、〜が普及し始めました。」など、漫画とは無関係でもよい。読者が「へえ」と思うような事実を1文で。豆知識を書く際は「豆知識として」という前置きは使わず、その内容だけを直接書くこと（例：「この「猫の日」は1987年に愛猫家グループによって制定されました。」）。
【厳守】
- 「現在です」「過去です」「未来です」などの語句は絶対に使わないこと。${dateFormatRule}
- 「〇〇年代の現在では」「2020年代の現在では」など、生成時点の「現在」に関する話題は一切書かないこと。
- 漫画の内容（黒ねこやキャラクター、情景の描写）や、制作者の意図（「〜を描写しました」「当時の情景として」など）は書かないこと。
- 「当時の世相を鮮やかに描いています」という文言は使わないこと。
- 文末は「〜しました。」「〜でした。」など、簡潔に終えること。
余計な前置きやJSONは不要。説明文のみ返すこと。`;
      }
      const result = await textModel.generateContent(prompt);
      let text = (result?.response?.text() || '').trim();
      // 制作者意図・描写言及を除去（プロンプトで禁止＋ここでも除去）
      text = text.replace(/当時の世相を鮮やかに描いています。?$/i, '').trim();
      text = text.replace(/当時の情景として描写しました。?$/gi, '').trim();
      text = text.replace(/[、,]?\s*それを見つめる[^。]*[。．]?$/g, '').trim();
      text = text.replace(/[、,]?\s*[^、。]*当時の情景として描写しました。?$/g, '').trim();
      // 「豆知識として」を除去
      text = text.replace(/豆知識として[、,]?\s*/g, '').trim();
      // 「〇〇年代の現在では」等、AIの「現在」時代に関する一文を除去
      text = text.replace(/[、,]?\s*[^。]*\d{4}年代の現在では[^。]*[。．]?/g, '').trim();
      text = text.replace(/[、,]?\s*[^。]*〇〇年代の現在では[^。]*[。．]?/g, '').trim();
      text = text.replace(/[、,]?\s*[^。]*現在では[^。]*ペットテック[^。]*[。．]?/g, '').trim();
      // 「今日は〇〇年×月△日、現在です。」等を「〇〇年×月△日は、」に変換
      text = text.replace(/(今日は)?(\d{4}年\d{1,2}月\d{1,2}日)[、,]\s*(現在|過去|未来)です[。．]?\s*/g, '$2は、');
      text = text.replace(/[、，]$/, '').trim();
      if (text.length > 0 && !/。$/.test(text)) text += '。';
      const note = text.slice(0, 140).replace(/\s+/g, ' ').trim();
      if (note) {
        await run('UPDATE comics SET background_note = ? WHERE date = ?', [note, date]);
      }
    } catch (bgErr) {
      console.warn('[まんが生成] 背景メモの生成をスキップ:', bgErr?.message || bgErr);
    }

    // === キャラクター画像の自動追加（改善版） ===
    // 1. テキストから登場キャラを検出
    const summaryTextForImage = (comic.episode_summary || '') + '\n' + (comic.summary || '') +
      panelPlans.map(p => p.description || p.content || '').join('\n');
    const mentionedForImage = getCharactersMentionedInText(summaryTextForImage, allChars);

    // 2. 検出されたキャラ＋明示選択キャラの両方のIDを収集（重複排除）
    const charIdsToInclude = new Set();
    // テキストで検出されたキャラのIDを追加
    mentionedForImage.forEach(c => charIdsToInclude.add(String(c.id)));
    // selected_characters も追加（明示選択分）
    if (comic.selected_characters) {
      comic.selected_characters.split(',').filter(Boolean).forEach(id => charIdsToInclude.add(id.trim()));
    }

    // 3. キャラ画像を参照画像として追加（重複なし）
    const includedCharNames = [];
    for (const charId of charIdsToInclude) {
      const char = await get('SELECT * FROM characters WHERE id = ?', [charId]);
      if (char?.image_path) {
        const charImgPath = path.join(UPLOADS_DIR, 'characters', char.image_path);
        if (fs.existsSync(charImgPath)) {
          const { buffer, mimeType } = await prepareRefImageForApi(charImgPath);
          contentsBase.push({ inlineData: { data: buffer.toString('base64'), mimeType } });
          includedCharNames.push(char.name);
        }
      }
    }
    if (includedCharNames.length > 0) {
      console.log(`[画像生成] キャラクター参照画像を追加: ${includedCharNames.join(', ')}`);
    }

    // 4. 追加参照画像
    if (comic.ref_images) {
      const refFiles = comic.ref_images.split(',').filter(Boolean);
      for (const refFile of refFiles) {
        const refPath = path.join(UPLOADS_DIR, 'comic_refs', refFile);
        if (fs.existsSync(refPath)) {
          const { buffer, mimeType } = await prepareRefImageForApi(refPath);
          contentsBase.push({ inlineData: { data: buffer.toString('base64'), mimeType } });
        }
      }
    }

    // 5. キャラ属性コンテキストを組み立て
    const characterContextForImage = mentionedForImage.length > 0
      ? mentionedForImage.map(c => `- ${c.name}: ${c.description || '（属性未設定）'}`).join('\n')
      : '';

    const numChunks = Math.ceil(panelCountSetting / panelsPerFile);
    let singleFilename = null;

    for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
      const start = chunkIndex * panelsPerFile;
      const end = Math.min(start + panelsPerFile, panelCountSetting);
      const plansChunk = panelPlans.slice(start, end);

      let imgBuffer = null;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          imgBuffer = await generateCombinedPanelImage(plansChunk, drawingStyle, strictRulesCombined, contentsBase, characterContextForImage, compositionRulesForGenerate, date, chunkIndex);
        } catch (genErr) {
          const isAbort = genErr?.name === 'AbortError' || /aborted/i.test(genErr?.message || '');
          if (isAbort && attempt < MAX_RETRIES) {
            console.warn(`${chunkIndex + 1}枚目の画像生成がタイムアウト/中断 (試行 ${attempt}/${MAX_RETRIES})、再試行します`);
            continue;
          }
          throw genErr;
        }
        if (imgBuffer) break;
        console.warn(`${chunkIndex + 1}枚目の画像生成に失敗 (試行 ${attempt}/${MAX_RETRIES})`);
      }
      if (!imgBuffer) {
        return res.status(500).json({
          error: `漫画の生成に失敗しました（${chunkIndex + 1}枚目）。${MAX_RETRIES}回試行しました。`
        });
      }

      // 提案B: セリフは画像生成時にAIが描き込むため、オーバーレイ埋め込みは行わない
      const filename = numChunks === 1
        ? `${date}-combined-${Date.now()}.png`
        : `${date}-strip-${chunkIndex + 1}-${Date.now()}.png`;
      const { absolutePath: outPath, relativePath: savedPath } = getGeneratedPathForDate(date, filename);
      fs.writeFileSync(outPath, imgBuffer);
      await saveImageGenerationMetadata(savedPath, date, drawingStyle, selectedStyleForMonochrome?.id, selectedStyleForMonochrome?.name);
      if (numChunks === 1) singleFilename = savedPath;

      for (let panelNum = start + 1; panelNum <= end; panelNum++) {
        await run(`
          INSERT INTO panels (comic_date, panel_number, image_path, status)
          VALUES (?, ?, ?, 'generated')
          ON CONFLICT(comic_date, panel_number) DO UPDATE SET
            image_path = excluded.image_path,
            status = 'generated'
        `, [date, panelNum, savedPath]);
      }
    }

    await run('UPDATE comics SET status = ? WHERE date = ?', ['completed', date]);

    const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const allPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);

    res.json({
      ...updatedComic,
      panels: allPanels,
      combined_image_path: singleFilename ?? undefined
    });
  } catch (err) {
    console.error('漫画生成エラー:', err);
    const message = err.message ? `漫画の生成に失敗しました。（${err.message}）` : '漫画の生成に失敗しました。';
    res.status(500).json({ error: message, details: err.message });
  }
});

// コマ再生成（テキスト指示）。4コマ1枚の場合は該当コマの指示だけ差し替えて縦長1枚を再生成する。複数ストリップ時は指定パネルが属するストリップ全体を再生成。
app.post('/api/comics/:date/panels/:num/regenerate', async (req, res) => {
  const { date, num } = req.params;
  const { prompt } = req.body;
  const panelNum = parseInt(num, 10);

  try {
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic) {
      return res.status(404).json({ error: '漫画が見つかりません。' });
    }

    const allPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    const isCombined = allPanels.length >= 2 && allPanels.every(p => p.image_path === (allPanels[0]?.image_path));
    const currentPanel = allPanels.find(p => p.panel_number === panelNum);
    const stripPanels = currentPanel ? allPanels.filter(p => p.image_path === currentPanel.image_path) : [];
    const isStrip = stripPanels.length >= 2;

    const undoFilename = await savePanelUndoBackup(date, panelNum);

    const drawingStyle = await getEffectiveDrawingStyleForComic();
    const selectedStyleRegen = await getSelectedImageStyleForComic();
    const styleRequiresMonochromeRegen = selectedStyleRegen && (selectedStyleRegen.color === '白黒' || selectedStyleRegen.color === '白黒のみ');
    const styleRefParts = await getStyleRefImageParts();
    const contentsBase = [];
    const useImageStyleConfigRegen = await hasImageStyleConfigSelected();
    if (styleRefParts.length > 0 && !useImageStyleConfigRegen) contentsBase.push(...styleRefParts);

    // === キャラクター画像の自動追加（改善版） ===
    const allChars = await all('SELECT * FROM characters ORDER BY created_at');
    // テキストから登場キャラを検出
    const summaryTextForRegen = (comic.episode_summary || '') + '\n' + (comic.summary || '') + '\n' + (prompt || '');
    const mentionedCharsRegen = getCharactersMentionedInText(summaryTextForRegen, allChars);
    // 検出されたキャラ＋明示選択キャラの両方のIDを収集（重複排除）
    const charIdsToIncludeRegen = new Set();
    mentionedCharsRegen.forEach(c => charIdsToIncludeRegen.add(String(c.id)));
    if (comic.selected_characters) {
      comic.selected_characters.split(',').filter(Boolean).forEach(id => charIdsToIncludeRegen.add(id.trim()));
    }
    // キャラ画像を参照画像として追加
    for (const charId of charIdsToIncludeRegen) {
      const char = await get('SELECT * FROM characters WHERE id = ?', [charId]);
      if (char?.image_path) {
        const charImgPath = path.join(UPLOADS_DIR, 'characters', char.image_path);
        if (fs.existsSync(charImgPath)) {
          const { buffer, mimeType } = await prepareRefImageForApi(charImgPath);
          contentsBase.push({ inlineData: { data: buffer.toString('base64'), mimeType } });
        }
      }
    }
    // キャラ属性コンテキスト
    const characterContextForRegen = mentionedCharsRegen.length > 0
      ? mentionedCharsRegen.map(c => `- ${c.name}: ${c.description || '（属性未設定）'}`).join('\n')
      : '';

    // 追加参照画像
    if (comic.ref_images) {
      const refFiles = comic.ref_images.split(',').filter(Boolean);
      for (const refFile of refFiles) {
        const refPath = path.join(UPLOADS_DIR, 'comic_refs', refFile);
        if (fs.existsSync(refPath)) {
          const { buffer, mimeType } = await prepareRefImageForApi(refPath);
          contentsBase.push({ inlineData: { data: buffer.toString('base64'), mimeType } });
        }
      }
    }

    let imgBuffer;
    let filename;
    // 実際に存在するパネル数に合わせて再生成対象のコマ数を決定（デフォルトは4コマ）
    const panelCountSetting = allPanels.length || 4;

    if (isCombined) {
      const strictRulesCombined = await getStrictStyleRulesForCombined(styleRequiresMonochromeRegen);
      let panelPlans = [];
      try {
        const parsed = JSON.parse(comic.summary || '[]');
        if (Array.isArray(parsed) && parsed.length > 0) {
          panelPlans = parsed.map((item) => ({
            panel: Number(item.panel) || 0,
            description: (item.content != null ? String(item.content) : item.description) || `${item.panel}コマ目`,
            aspect: (() => {
            const a = item.aspect;
            if (a === 'landscape' || a === 'portrait' || a === 'square') return a;
            if (typeof a === 'string' && /^\d+:\d+$/.test(a)) return a;
            return 'square';
          })()
          }));
        }
      } catch (_) {}
      for (let i = 1; i <= panelCountSetting; i++) {
        if (!panelPlans.find(p => p.panel === i)) {
          panelPlans.push({ panel: i, description: `${i}コマ目` });
        }
      }
      const planToReplace = panelPlans.find(p => p.panel === panelNum);
      if (planToReplace) planToReplace.description = prompt;

      const conceptConfigRegen = await getConceptConfig();
      const compositionRulesRegen = conceptConfigRegen?.composition_rules || '';
      imgBuffer = await generateCombinedPanelImage(panelPlans, drawingStyle, strictRulesCombined, contentsBase, characterContextForRegen, compositionRulesRegen, date);
      if (!imgBuffer) {
        return res.status(500).json({ error: '画像生成に失敗しました。' });
      }
      // 提案B: セリフはAIが画像内に描くためオーバーレイ不要
      filename = `${date}-combined-${Date.now()}.png`;
      const { absolutePath: outPathCombined, relativePath: savedPathCombined } = getGeneratedPathForDate(date, filename);
      fs.writeFileSync(outPathCombined, imgBuffer);
      await saveImageGenerationMetadata(savedPathCombined, date, drawingStyle, selectedStyleRegen?.id, selectedStyleRegen?.name);
      for (let i = 1; i <= panelCountSetting; i++) {
        await run(`
          UPDATE panels SET image_path = ?, previous_image_path = ?, status = 'generated'
          WHERE comic_date = ? AND panel_number = ?
        `, [savedPathCombined, undoFilename || null, date, i]);
      }
    } else if (isStrip) {
      const strictRulesCombined = await getStrictStyleRulesForCombined(styleRequiresMonochromeRegen);
      const stripPanelNumbers = stripPanels.map(p => p.panel_number).sort((a, b) => a - b);
      let panelPlans = [];
      try {
        const parsed = JSON.parse(comic.summary || '[]');
        if (Array.isArray(parsed) && parsed.length > 0) {
          const byPanel = parsed.map((item) => ({
            panel: Number(item.panel) || 0,
            description: (item.content != null ? String(item.content) : item.description) || `${item.panel}コマ目`,
            aspect: (() => {
            const a = item.aspect;
            if (a === 'landscape' || a === 'portrait' || a === 'square') return a;
            if (typeof a === 'string' && /^\d+:\d+$/.test(a)) return a;
            return 'square';
          })()
          }));
          for (const n of stripPanelNumbers) {
            const plan = byPanel.find(p => p.panel === n) || { panel: n, description: `${n}コマ目`, aspect: 'square' };
            panelPlans.push(plan);
          }
        }
      } catch (_) {}
      while (panelPlans.length < 4) {
        const n = stripPanelNumbers[0] + panelPlans.length;
        panelPlans.push({ panel: n, description: `${n}コマ目`, aspect: 'square' });
      }
      const promptMatch = prompt.match(/(\d+)\s*コマ目/);
      const promptPanelInStrip = promptMatch ? Math.max(1, Math.min(4, parseInt(promptMatch[1], 10))) : 1;
      const planIndexToReplace = promptPanelInStrip - 1;
      if (panelPlans[planIndexToReplace]) panelPlans[planIndexToReplace].description = prompt;

      const conceptConfigStrip = await getConceptConfig();
      const compositionRulesStrip = conceptConfigStrip?.composition_rules || '';
      const panelsPerFileRegen = parseInt(await getSetting('panels_per_file'), 10) || 4;
      const stripChunkIndex = Math.floor((stripPanelNumbers[0] - 1) / panelsPerFileRegen); // 2枚目以降の冒頭文字コマは日付不要
      imgBuffer = await generateCombinedPanelImage(panelPlans.slice(0, 4), drawingStyle, strictRulesCombined, contentsBase, '', compositionRulesStrip, date, stripChunkIndex);
      if (!imgBuffer) {
        return res.status(500).json({ error: '画像生成に失敗しました。' });
      }
      // 提案B: セリフはAIが画像内に描くためオーバーレイ不要
      filename = `${date}-strip-regen-${stripPanelNumbers[0]}-${Date.now()}.png`;
      const { absolutePath: outPathStrip, relativePath: savedPathStrip } = getGeneratedPathForDate(date, filename);
      fs.writeFileSync(outPathStrip, imgBuffer);
      await saveImageGenerationMetadata(savedPathStrip, date, drawingStyle, selectedStyleRegen?.id, selectedStyleRegen?.name);
      for (const p of stripPanels) {
        await run(`
          UPDATE panels SET image_path = ?, previous_image_path = ?, status = 'generated'
          WHERE comic_date = ? AND panel_number = ?
        `, [savedPathStrip, undoFilename || null, date, p.panel_number]);
      }
    } else {
      const strictRules = await getStrictStyleRules(styleRequiresMonochromeRegen);
      const c = await getConceptConfig();
      const mainCharacterDoesNotSpeakRegen = c?.main_character?.speaks === false;
      let isMonochrome = c?.color === '白黒' || c?.color === '白黒のみ';
      if (!isMonochrome && styleRequiresMonochromeRegen) isMonochrome = true;
      const colorInstruction = isMonochrome
        ? ''
        : '\n【カラー描画（絶対厳守・最重要）】\n- **必ずフルカラーで描くこと。白黒、グレースケール、モノクロは絶対に禁止。**\n- **上記の【画風】に従った色使いとライティングを適用すること。**\n- **参照画像がある場合は同じカラーパレットと色調を維持すること。**\n- **この指示は最重要です。白黒で描いてはいけません。必ずカラーで描いてください。**\n';

      const styleFromImageStyleConfigRegen = typeof drawingStyle === 'string' && drawingStyle.includes('画風設定');
      const serifConfigRegen = getSerifFontConfig();
      const serifUnifyBlockRegen = serifConfigRegen?.name
        ? `\n【吹き出しの文字（全生成で統一・絶対厳守）】
- **画風・シナリオ・日付・コマの内容に依存せず、吹き出し内の文字は常に「${serifConfigRegen.name}」のようなゴシック体サンセリフで統一すること。** 手書き風・明朝体・丸ゴシック・デザイン書体など別の書体に変えないこと。どの日・どの話・どの画風でも同じ文字スタイルにすること。

`
        : '';
      const summaryForImagePrompt = (() => {
        try {
          const parsed = JSON.parse(comic.summary || '[]');
          const panels = Array.isArray(parsed) ? parsed : (parsed?.panels || []);
          return panels.map((item) => {
            const safe = getPromptSafePanelContent(item?.content || item?.description || '');
            return {
              ...item,
              content: safe.normalizedContent,
              prompt_content: safe.body,
              serif_texts: safe.serifTexts
            };
          });
        } catch (_) {
          return comic.summary || '';
        }
      })();
      const safePromptContent = getPromptSafePanelContent(prompt || '');
      const imagePromptText = `
${styleFromImageStyleConfigRegen ? '【最優先・絶対厳守】この画像の描画スタイルは、以下の【画風】の指示のみに従うこと。参照画像（キャラ参照）は「誰が登場するか・見た目の目安」の参考のみとする。描画スタイル・タッチ・質感・色調は参照画像に合わせず、必ず【画風】の通りに描くこと。出力が写実的・3D CG風・リアル調になった場合は誤りである。\n\n' : ''}
【カラー描画（最重要・最初に確認）】
${isMonochrome ? '【厳守】白黒のみで描くこと。' : '【絶対厳守】この画像は必ずフルカラーで描くこと。白黒、グレースケール、モノクロは絶対に禁止。上記の【画風】に従った色使いとライティングを適用すること。'}

【画風】（厳守）
${drawingStyle}

${strictRules}${colorInstruction}
${serifUnifyBlockRegen}
【画風参照画像について（最重要）】
- 参照画像がある場合、上記の【画風】で描くこと。キャラクターの見た目・構図は参照を参考にしつつ、画風は【画風】の指示に厳密に従うこと
${styleFromImageStyleConfigRegen ? '- **参照画像の画風・タッチをまねないこと。参照は「誰を描くか」のためだけに使い、線の質感・彩色・立体感はすべて【画風】の指示に従うこと。**\n' : ''}

【元のコミック情報】
テーマ: ${comic.theme}
構成: ${typeof summaryForImagePrompt === 'string' ? summaryForImagePrompt : JSON.stringify(summaryForImagePrompt)}

【このコマの修正指示】
${safePromptContent.body || safePromptContent.normalizedContent || ''}
${safePromptContent.serifTexts.length > 0 ? `\n【吹き出しに入れるセリフ】\n${safePromptContent.serifTexts.map((text) => `- 「${text}」`).join('\n')}` : ''}

【人間の描写について（最重要）】
- 人間の風貌や風景など、猫とキャラクター以外はほぼ登場させないこと
- 人間の子供や大人の会話は吹き出しとセリフで表現すること
- 必要に応じて人間がシルエットで登場することがあってもOK
- **人間のシルエットは、立体感をつけず、ただ暗いぼんやりした、輪郭のないシルエットで描くこと。リアルなシルエットや詳細な輪郭、立体感やライティングは避け、平面的でぼやけた暗い影のようなシルエットにすること**
- 人間の詳細な風貌や服装、風景の詳細な描写は避け、猫やキャラクターが中心となるように描くこと

【セリフの扱い（絶対厳守）】
- このコマの説明テキストの中に「【発話者：セリフ内容】」形式でセリフが書かれている場合、そのセリフ内容を必ず画像内の吹き出しとして描き込むこと
- **構成シナリオに書かれたセリフの文字をそのまま描画すること。** ひらがな・カタカナ・アルファベット・数字をその通りに描くこと。漢字は使わないこと。アルファベットや数字が含まれる場合も、そのまま正確に描画すること。
- **吹き出し内には「ひと：」「そうべい：」「子供A：」などの話者名を絶対に書かないこと。** セリフ内容のみを描くこと。
- 吹き出しの文字サイズは小さめに、読みやすいサイズで描くこと
- **【厳守】セリフも必ず右から順に配置すること。** 1コマ内にセリフが2つ以上ある場合、先に読むセリフ＝右側、後に読むセリフ＝左側。日本の漫画は右から左へ読む。
${(() => { const s = getSerifFontConfig(); return s?.name ? `- **吹き出し内の文字は、${s.name} のようなゴシック体のサンセリフで、読みやすく統一して描くこと。全コマで同じフォントスタイル（太さ・字間・角の丸み）に揃えること。**\n` : ''; })()}- セリフが複数ある場合も、すべてのセリフが何らかの吹き出しとして画像内に存在するようにすること
${mainCharacterDoesNotSpeakRegen ? '- **主役の黒ねこ（主役の猫）は話さない設定のため、黒猫・主役の猫からは吹き出しを絶対に出さないこと。黒猫にセリフの吹き出しを描いてはいけない。**\n' : ''}${c?.main_character ? '- **主役の黒ねこ（主役の猫）は1コマに1匹のみ。同じコマに2匹以上描かないこと。**\n' : ''}

【注意】
- キャラクター名・話者名（例：子供A、〇〇、ひと）は画像内に絶対に表記しないこと。吹き出し内には話者名（「ひと：」など）を絶対に書かないこと。
- 1枚の画像に1コマ分だけのイラストを描くこと。枠で分割したり複数コマを並べた絵は禁止
- 1コマの正方形のイラストとして描いてください（サイズは ${PANEL_SIZE}x${PANEL_SIZE} で統一）。上記の【画風】を厳守すること
`;
      const contents = styleFromImageStyleConfigRegen
        ? [{ text: imagePromptText }, ...contentsBase]
        : [...contentsBase, { text: imagePromptText }];
      imgBuffer = await generatePanelImage(contents, imagePromptText);
      if (!imgBuffer) {
        return res.status(500).json({ error: '画像生成に失敗しました。' });
      }
      // 提案B: セリフはAIが画像内に描くためオーバーレイ不要
      filename = `${date}-panel-${panelNum}-${Date.now()}.png`;
      const { absolutePath: outPathPanel, relativePath: savedPathPanel } = getGeneratedPathForDate(date, filename);
      fs.writeFileSync(outPathPanel, imgBuffer);
      await saveImageGenerationMetadata(savedPathPanel, date, drawingStyle, selectedStyleRegen?.id, selectedStyleRegen?.name);
      await run(`
        UPDATE panels SET image_path = ?, previous_image_path = ?, status = 'generated'
        WHERE comic_date = ? AND panel_number = ?
      `, [savedPathPanel, undoFilename || null, date, panelNum]);
    }

    const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const updatedPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    res.json({ ...updatedComic, panels: updatedPanels });
  } catch (err) {
    console.error('コマ再生成エラー:', err);
    res.status(500).json({ error: 'コマの再生成に失敗しました。', details: err.message });
  }
});

// Inpaint（マスクのみ指定・コマ番号不要。赤いマスク領域の bounding box でパッチのみ Inpaint して貼り戻す）
app.post('/api/comics/:date/inpaint', async (req, res) => {
  const INPAINT_TIMEOUT_MS = 300000;
  res.setTimeout(INPAINT_TIMEOUT_MS, () => {
    if (!res.headersSent) res.status(504).json({ error: 'Inpaint処理がタイムアウトしました。しばらく待って再試行してください。' });
  });
  const t0 = Date.now();
  console.log('[Inpaint] リクエスト受信');
  const { date } = req.params;
  const { mask, prompt, panel_num: bodyPanelNum, inpaint_mode: inpaintMode, overlay_vertical: overlayVertical, overlay_font_scale: overlayFontScaleRaw, mask_margin: maskMarginRaw, edge_feather: edgeFeatherRaw } = req.body;
  const isSerifMode = inpaintMode !== 'illustration';
  const overlayVerticalOption = overlayVertical !== false && overlayVertical !== 'false';
  const overlayFontScaleNum = typeof overlayFontScaleRaw === 'number' ? overlayFontScaleRaw : parseFloat(String(overlayFontScaleRaw || '1'));
  const overlayFontScale = (!Number.isNaN(overlayFontScaleNum) && overlayFontScaleNum >= 0.5 && overlayFontScaleNum <= 2)
    ? overlayFontScaleNum
    : 1;
  // マスクマージン: 0〜20px。未指定時はモード別デフォルト（イラスト0、セリフ8）
  const maskMarginNum = typeof maskMarginRaw === 'number' ? maskMarginRaw : parseInt(String(maskMarginRaw || ''), 10);
  const boxMarginPxDefault = inpaintMode === 'illustration' ? 0 : 8;
  const boxMarginPx = (!Number.isNaN(maskMarginNum) && maskMarginNum >= 0 && maskMarginNum <= 20)
    ? maskMarginNum
    : boxMarginPxDefault;
  // エッジぼかし: 0〜8px。未指定時は1。イラスト修正のブレンド時のみ使用
  const edgeFeatherNum = typeof edgeFeatherRaw === 'number' ? edgeFeatherRaw : parseInt(String(edgeFeatherRaw ?? ''), 10);
  const edgeFeatherPx = (!Number.isNaN(edgeFeatherNum) && edgeFeatherNum >= 0 && edgeFeatherNum <= 8)
    ? edgeFeatherNum
    : 1;

  try {
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const allPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    if (!comic || allPanels.length === 0) {
      return res.status(404).json({ error: '漫画が見つかりません。' });
    }
    const panelNumForStrip = bodyPanelNum != null ? parseInt(String(bodyPanelNum), 10) : null;
    const panel = panelNumForStrip != null
      ? allPanels.find(p => p.panel_number === panelNumForStrip) || allPanels[0]
      : allPanels[0];
    const stripPanels = allPanels.filter(p => p.image_path === (panel?.image_path));
    const isCombined = stripPanels.length >= 2;
    const panelsToUpdate = stripPanels.length >= 1 ? stripPanels : allPanels;

    const undoFilename = await savePanelUndoBackup(date, panel?.panel_number ?? 1);

    const drawingStyle = await getEffectiveDrawingStyleForComic();
    const selectedStyleInpaintStrip = await getSelectedImageStyleForComic();
    const styleRequiresMonochromeInpaintStrip = selectedStyleInpaintStrip && (selectedStyleInpaintStrip.color === '白黒' || selectedStyleInpaintStrip.color === '白黒のみ');
    // Inpaint時は構成・コマ割り関連のstrictRulesは不要（ユーザー指示最優先のため）
    const c = await getConceptConfig();
    // イラスト修正時は漫画で使用中のキャラクター名・説明をプロンプトに含める
    let characterContextForInpaint = '';
    if (!isSerifMode && comic.selected_characters) {
      const charIds = comic.selected_characters.split(',').map(s => String(s).trim()).filter(Boolean);
      if (charIds.length > 0) {
        const placeholders = charIds.map(() => '?').join(',');
        const chars = await all(`SELECT name, description FROM characters WHERE id IN (${placeholders})`, charIds);
        if (chars.length > 0) {
          characterContextForInpaint = '\n【登場キャラクター】（修正指示で名前を出す場合はこれらを参照）\n' +
            chars.map(ch => `- ${ch.name}: ${ch.description || '説明なし'}`).join('\n') + '\n';
        }
      }
    }
    let isMonochrome = c?.color === '白黒' || c?.color === '白黒のみ';
    if (!isMonochrome && styleRequiresMonochromeInpaintStrip) isMonochrome = true;
    const colorInstruction = isMonochrome
      ? ''
      : '\n【カラー描画（絶対厳守・最重要）】\n- **必ずフルカラーで描くこと。白黒、グレースケール、モノクロは絶対に禁止。**\n- **上記の【画風】に従った色使いとライティングを適用すること。**\n- **元の画像と同じカラーパレットと色調を維持すること。**\n- **この指示は最重要です。白黒で描いてはいけません。必ずカラーで描いてください。**\n';

    const originalPath = path.join(GENERATED_DIR, panel.image_path);
    if (!fs.existsSync(originalPath)) {
      return res.status(404).json({ error: '元画像が見つかりません。' });
    }
    const originalBuffer = fs.readFileSync(originalPath);
    const originalImage = sharp(originalBuffer);
    const originalMeta = await originalImage.metadata();
    const originalWidth = originalMeta.width || PANEL_SIZE;
    const originalHeight = originalMeta.height || COMBINED_PANEL_HEIGHT;

    const maskBase64 = mask.replace(/^data:image\/\w+;base64,/, '');
    let maskBuffer = Buffer.from(maskBase64, 'base64');
    const maskMeta = await sharp(maskBuffer).metadata();
    const maskWidth = maskMeta.width || 0;
    const maskHeight = maskMeta.height || 0;
    if (maskWidth !== originalWidth || maskHeight !== originalHeight) {
      maskBuffer = await sharp(maskBuffer)
        .resize(originalWidth, originalHeight, { fit: 'fill' })
        .png()
        .toBuffer();
      console.warn(`[Inpaint] マスクサイズ(${maskWidth}x${maskHeight})が元画像(${originalWidth}x${originalHeight})と不一致のためリサイズしました。`);
    }

    let globalBox = await getMaskBoundingBox(maskBuffer, boxMarginPx);
    if (!globalBox) {
      const errMsg = inpaintMode === 'illustration'
        ? 'マスクに赤い領域が検出されません。修正したい部分を赤で塗ってください。'
        : 'マスクに赤い領域が検出されません。修正したい吹き出し部分を赤で塗ってください。';
      return res.status(400).json({ error: errMsg });
    }

    // 結合ストリップ時は常にマスクの中心Yから対象コマを特定（ユーザーが塗ったコマと一致させる）
    // クライアントの panel_num は「どのストリップ画像か」の識別用で、塗ったコマ番号とは限らない
    let effectivePanelNum = panelNumForStrip;
    if (isCombined) {
      const rects = getPanelRectsForStrip(originalWidth, originalHeight, panelsToUpdate, comic.summary || '');
      const centerY = globalBox.top + globalBox.height / 2;
      const containing = rects.find(r => centerY >= r.top && centerY < r.top + r.height);
      effectivePanelNum = containing ? containing.panel_number : (panelNumForStrip ?? panelsToUpdate[0]?.panel_number ?? 1);
    }

    // セリフ/オーバーレイ共通: 塗り・文字色は parseOverlaySerifInstruction の useBlackFill で制御
    const BLACK_FILL = { r: 0, g: 0, b: 0 };
    // テキストオーバーレイ: デフォルト＝白塗り+黒文字／"++"付き＝黒塗り+白文字
    if (inpaintMode === 'overlay') {
      const parsed = parseOverlaySerifInstruction(prompt);
      console.log('[Inpaint overlay] parsed:', parsed.mode, parsed.useBlackFill ? '++' : '', parsed.text ? `"${parsed.text.substring(0, 20)}..."` : '');
      if (parsed.mode === 'plain' && !parsed.text) {
        return res.status(400).json({ error: 'オーバーレイする文言を入力してください。（白塗りのみ: **削除／黒塗り+白文字: ++「文言」）' });
      }
      const fillColor = parsed.useBlackFill ? BLACK_FILL : null;
      const textColor = parsed.useBlackFill ? 'white' : 'black';
      let overlayBuffer;
      let compositeTop;
      let compositeLeft;
      const needFill = parsed.mode === 'delete' || parsed.mode === 'bracket';
      const needTextOverlay = parsed.mode === 'plain' || (parsed.mode === 'bracket' && parsed.text);
      let boxW;
      let boxH;
      if (isCombined) {
        const rects = getPanelRectsForStrip(originalWidth, originalHeight, panelsToUpdate, comic.summary || '');
        const rect = rects.find(r => r.panel_number === effectivePanelNum) || rects[0];
        const maskPanelBuffer = await sharp(maskBuffer)
          .extract({ left: 0, top: rect.top, width: originalWidth, height: rect.height })
          .png()
          .toBuffer();
        const boxInPanel = await getMaskBoundingBox(maskPanelBuffer, 0);
        if (!boxInPanel) {
          return res.status(400).json({ error: 'このコマ内にマスク領域が検出されません。' });
        }
        boxW = boxInPanel.width;
        boxH = boxInPanel.height;
        compositeTop = rect.top + boxInPanel.top;
        compositeLeft = boxInPanel.left;
        overlayBuffer = needFill ? await createWhitePatchBuffer(boxW, boxH, fillColor) : null;
        if (needTextOverlay) {
          const textBuf = await renderSerifOverlayToBuffer(parsed.text, boxW, boxH, { vertical: overlayVerticalOption, fontSizeScale: overlayFontScale, textColor });
          overlayBuffer = overlayBuffer
            ? await sharp(overlayBuffer).composite([{ input: textBuf, top: 0, left: 0 }]).png().toBuffer()
            : textBuf;
        }
      } else {
        const tightBox = await getMaskBoundingBox(maskBuffer, 0);
        if (!tightBox) {
          return res.status(400).json({ error: 'マスクに赤い領域が検出されません。' });
        }
        boxW = tightBox.width;
        boxH = tightBox.height;
        compositeTop = tightBox.top;
        compositeLeft = tightBox.left;
        overlayBuffer = needFill ? await createWhitePatchBuffer(boxW, boxH, fillColor) : null;
        if (needTextOverlay) {
          const textBuf = await renderSerifOverlayToBuffer(parsed.text, boxW, boxH, { vertical: overlayVerticalOption, fontSizeScale: overlayFontScale, textColor });
          overlayBuffer = overlayBuffer
            ? await sharp(overlayBuffer).composite([{ input: textBuf, top: 0, left: 0 }]).png().toBuffer()
            : textBuf;
        }
      }
      if (!overlayBuffer) {
        return res.status(400).json({ error: 'オーバーレイする文言を入力してください。' });
      }
      const finalStripBuffer = await sharp(originalBuffer)
        .composite([{ input: overlayBuffer, top: compositeTop, left: compositeLeft, blend: 'over' }])
        .png()
        .toBuffer();
      const filename = `${date}-inpaint-overlay-${Date.now()}.png`;
      const { absolutePath: outPathOverlay, relativePath: savedPathOverlay } = getGeneratedPathForDate(date, filename);
      fs.writeFileSync(outPathOverlay, finalStripBuffer);
      for (const p of panelsToUpdate) {
        await run(`
          UPDATE panels SET image_path = ?, previous_image_path = ?, status = 'generated'
          WHERE comic_date = ? AND panel_number = ?
        `, [savedPathOverlay, undoFilename || null, date, p.panel_number]);
      }
      const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
      const updatedPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
      return res.json({ ...updatedComic, panels: updatedPanels });
    }

    // セリフ/オーバーレイ共通: 「」「**削除」の解析（イラスト修正では未使用）
    const serifParsed = (isSerifMode || inpaintMode === 'overlay') ? parseOverlaySerifInstruction(prompt) : null;

    // イラスト修正時: 短いプロンプトを具体的な指示に展開（モデルが指示を通じやすくする）
    const effectivePrompt = isSerifMode
      ? (serifParsed?.mode === 'bracket' ? serifParsed.text : prompt)
      : await expandIllustrationPrompt(prompt, characterContextForInpaint);

    const serifBracketNote = serifParsed?.mode === 'bracket'
      ? (serifParsed.useBlackFill
          ? '\n- 【重要】1枚目のマスク部分は黒塗り済み。その黒い領域に【書き換え文言】を**必ず白い文字（#FFFFFF）で**描くこと。黒文字では不可。\n'
          : '\n- 1枚目のマスク部分は白塗り済み。その上に【書き換え文言】を**黒い文字**で描くこと。\n')
      : '';
    const inpaintPrompt = isSerifMode
      ? `
【前提】これは既存画像の**編集**です。1枚目の画像にはすでに吹き出し・キャラ・背景が描かれています。あなたの仕事は、白マスクで示した**吹き出し内の文字部分だけ**を、指定の文言に差し替えることです。吹き出しの枠・しっぽ・キャラクター・背景は描き直さないでください。

【タスク】
- 1枚目: 既存の局部画像（吹き出し・キャラ含む）、2枚目: マスク（白=文字だけ差し替え、黒=変更禁止）。
- 白マスク部分を以下の【書き換え文言】の**テキストだけ**に置き換える。吹き出しの形・地・枠は1枚目をそのまま維持し、文字のみ描き換えること。
- 文字の見た目は1枚目の既存セリフに近く（同程度の大きさ・太さ）にすること。${serifParsed?.mode === 'bracket' ? (serifParsed.useBlackFill ? '色は必ず白にすること。' : '色は黒にすること。') : '色も近くにすること。'}${serifBracketNote}

【書き換え文言】
${effectivePrompt}

【守ること】
- 吹き出し内には「ひと：」「そうべい：」などの話者名を絶対に書かないこと。セリフ内容のみを描くこと。書き換え文言に話者名が含まれている場合は除く。
- マスク（白）には**文字だけ**。吹き出しの枠・しっぽ・キャラ・背景・イラストは描かない（1枚目をそのまま使う）。
- マスク（黒）は変更しない。出力は1枚目と同じサイズで返す。

[NEGATIVE - STRICT] You are EDITING image 1, not composing a new scene. Do NOT redraw the speech bubble outline, tail, or shape. Do NOT draw any character, speaker figure, portrait, icon, or illustration. Image 1 already has the bubble and characters; only the text inside the white mask must be replaced with the phrase above. The white area must contain Japanese text glyphs only, nothing else.
`
      : `
[INPAINTING TASK - CRITICAL]
Image 1 = source image (crop). Image 2 = mask (WHITE = region to EDIT, BLACK = preserve UNCHANGED).
Output MUST be the exact same dimensions as Image 1. Change ONLY the white area. Leave black areas pixel-identical.

【ユーザーの修正指示】（最優先・必ず従うこと）
${effectivePrompt}
${characterContextForInpaint}

【タスク】
マスクの白領域のみを上記の修正指示どおりにイラストで描き直す。黒領域は一切変更しない。
元の画風・タッチ・質感を維持すること。

【画風】
${drawingStyle}
${colorInstruction}

【厳守】
- 出力画像は Image 1 と同一サイズであること
- マスク白部分だけを編集、黒部分は変更禁止
- キャラクター名・話者名を画像内に表記しないこと
${isMonochrome ? '- 白黒のみで描くこと' : '- フルカラーで描くこと。白黒・グレースケールは禁止'}
`;

    if (await getImageProvider() === 'openai') {
      return res.status(400).json({ error: 'Inpaint（部分修正）は OpenAI では未対応です。IMAGE_PROVIDER=gemini で利用してください。' });
    }

    let finalStripBuffer;

    if (isCombined) {
      const rects = getPanelRectsForStrip(originalWidth, originalHeight, panelsToUpdate, comic.summary || '');
      const rect = rects.find(r => r.panel_number === effectivePanelNum) || rects[0];
      const originalPanelBuffer = await sharp(originalBuffer)
        .extract({ left: 0, top: rect.top, width: originalWidth, height: rect.height })
        .png()
        .toBuffer();
      const maskPanelBuffer = await sharp(maskBuffer)
        .extract({ left: 0, top: rect.top, width: originalWidth, height: rect.height })
        .png()
        .toBuffer();

      const boxInPanel = await getMaskBoundingBox(maskPanelBuffer, boxMarginPx);
      if (!boxInPanel) {
        return res.status(400).json({ error: 'このコマ内にマスク領域が検出されません。' });
      }

      // 「削除」: useBlackFill なら黒塗り、でなければ白塗り
      const isDelete = (isSerifMode && serifParsed?.mode === 'delete') || (!isSerifMode && isInpaintDeleteInstruction(prompt));
      if (isDelete) {
        const tightBox = await getMaskBoundingBox(maskPanelBuffer, 0);
        if (!tightBox) {
          return res.status(400).json({ error: 'このコマ内にマスク領域が検出されません。' });
        }
        const fillColorDelete = (isSerifMode && serifParsed?.useBlackFill) ? BLACK_FILL : null;
        const deletePatch = await createWhitePatchBuffer(tightBox.width, tightBox.height, fillColorDelete);
        finalStripBuffer = await sharp(originalBuffer)
          .composite([{ input: deletePatch, top: rect.top + tightBox.top, left: tightBox.left, blend: 'over' }])
          .png()
          .toBuffer();
      } else {
      // セリフモードで「」のとき: 塗り済み画像からパッチを切り出す（useBlackFill で白/黒を切り替え）
      let panelForPatch = originalPanelBuffer;
      if (isSerifMode && serifParsed?.mode === 'bracket') {
        const tightBoxBracket = await getMaskBoundingBox(maskPanelBuffer, 0);
        if (tightBoxBracket) {
          const fillColorBracket = serifParsed?.useBlackFill ? BLACK_FILL : null;
          const fillForBracket = await createWhitePatchBuffer(tightBoxBracket.width, tightBoxBracket.height, fillColorBracket);
          const baseWithFill = await sharp(originalBuffer)
            .composite([{ input: fillForBracket, top: rect.top + tightBoxBracket.top, left: tightBoxBracket.left, blend: 'over' }])
            .png()
            .toBuffer();
          panelForPatch = await sharp(baseWithFill)
            .extract({ left: 0, top: rect.top, width: originalWidth, height: rect.height })
            .png()
            .toBuffer();
        }
      }
      const originalPatch = await sharp(panelForPatch)
        .extract(boxInPanel)
        .png()
        .toBuffer();
      const maskPatch = await sharp(maskPanelBuffer)
        .extract(boxInPanel)
        .png()
        .toBuffer();
      const maskPatchBinarized = await binarizeMaskPatch(maskPatch);

      // 元パッチのテキスト高さを推定（セリフモード時のみ）
      let originalTextHeight = null;
      if (isSerifMode) {
        originalTextHeight = await estimateTextBoxHeight(originalPatch);
      }

      // イラスト修正時はテキストを先頭に（タスクを先に伝えて指示を通じやすくする）
      const combinedContents = isSerifMode
        ? [
            { inlineData: { data: originalPatch.toString('base64'), mimeType: 'image/png' } },
            { inlineData: { data: maskPatchBinarized.toString('base64'), mimeType: 'image/png' } },
            { text: inpaintPrompt }
          ]
        : [
            { text: inpaintPrompt },
            { inlineData: { data: originalPatch.toString('base64'), mimeType: 'image/png' } },
            { inlineData: { data: maskPatchBinarized.toString('base64'), mimeType: 'image/png' } }
          ];
      console.log('[Inpaint] Gemini API呼び出し開始（combined）');
      const patchBuffer = await generatePanelImageWithGemini(combinedContents);
      console.log(`[Inpaint] Gemini API応答（combined）: ${Date.now() - t0}ms`);
      if (!patchBuffer) {
        return res.status(500).json({ error: 'Inpaintに失敗しました。' });
      }
      const patchMeta = await sharp(patchBuffer).metadata();
      let patchToComposite = patchBuffer;
      if (patchMeta.width !== boxInPanel.width || patchMeta.height !== boxInPanel.height) {
        patchToComposite = await sharp(patchBuffer)
          .resize(boxInPanel.width, boxInPanel.height, { fit: 'cover' })
          .png()
          .toBuffer();
      }

      // イラスト修正: マスク外は元画像を維持（AIの色ずれを防ぐ）
      if (inpaintMode === 'illustration') {
        patchToComposite = await blendInpaintPatchWithMask(originalPatch, patchToComposite, maskPatchBinarized, { featherPx: edgeFeatherPx });
      }

      // セリフモードで、生成結果の文字が小さすぎる場合はパッチ内でズームしてから貼り戻す
      if (isSerifMode && originalTextHeight) {
        const newTextHeight = await estimateTextBoxHeight(patchToComposite);
        if (newTextHeight && newTextHeight < originalTextHeight * 0.85) {
          const targetW = boxInPanel.width;
          const targetH = boxInPanel.height;
          const scale = Math.min(originalTextHeight / newTextHeight, 1.8);
          const scaledW = Math.max(targetW, Math.round(targetW * scale));
          const scaledH = Math.max(targetH, Math.round(targetH * scale));

          try {
            const enlarged = await sharp(patchToComposite)
              .resize(scaledW, scaledH, {
                fit: 'contain',
                background: { r: 255, g: 255, b: 255, alpha: 0 }
              })
              .png()
              .toBuffer();

            const leftCrop = Math.max(0, Math.floor((scaledW - targetW) / 2));
            const topCrop = Math.max(0, Math.floor((scaledH - targetH) / 2));

            patchToComposite = await sharp(enlarged)
              .extract({ left: leftCrop, top: topCrop, width: targetW, height: targetH })
              .png()
              .toBuffer();
          } catch (e) {
            console.warn('セリフ拡大処理（combined）に失敗:', e.message);
          }
        }
      }

      finalStripBuffer = await sharp(originalBuffer)
        .composite([{ input: patchToComposite, top: rect.top + boxInPanel.top, left: boxInPanel.left }])
        .png()
        .toBuffer();
      }
    } else {
      // 単一パネル
      const isDelete = (isSerifMode && serifParsed?.mode === 'delete') || (!isSerifMode && isInpaintDeleteInstruction(prompt));
      if (isDelete) {
        const tightBox = await getMaskBoundingBox(maskBuffer, 0);
        if (!tightBox) {
          return res.status(400).json({ error: 'マスクに赤い領域が検出されません。' });
        }
        const fillColorDelete = (isSerifMode && serifParsed?.useBlackFill) ? BLACK_FILL : null;
        const deletePatch = await createWhitePatchBuffer(tightBox.width, tightBox.height, fillColorDelete);
        finalStripBuffer = await sharp(originalBuffer)
          .composite([{ input: deletePatch, top: tightBox.top, left: tightBox.left, blend: 'over' }])
          .png()
          .toBuffer();
      } else {
      // セリフモードで「」のとき: 塗り済み画像からパッチを切り出す（useBlackFill で白/黒を切り替え）
      let baseForPatch = originalBuffer;
      if (isSerifMode && serifParsed?.mode === 'bracket') {
        const tightBoxBracket = await getMaskBoundingBox(maskBuffer, 0);
        if (tightBoxBracket) {
          const fillColorBracket = serifParsed?.useBlackFill ? BLACK_FILL : null;
          const fillForBracket = await createWhitePatchBuffer(tightBoxBracket.width, tightBoxBracket.height, fillColorBracket);
          baseForPatch = await sharp(originalBuffer)
            .composite([{ input: fillForBracket, top: tightBoxBracket.top, left: tightBoxBracket.left, blend: 'over' }])
            .png()
            .toBuffer();
        }
      }
      const originalPatch = await sharp(baseForPatch)
        .extract(globalBox)
        .png()
        .toBuffer();
      const maskPatch = await sharp(maskBuffer)
        .extract(globalBox)
        .png()
        .toBuffer();
      const maskPatchBinarized = await binarizeMaskPatch(maskPatch);

      // 元パッチのテキスト高さを推定（セリフモード時のみ）
      let originalTextHeight = null;
      if (isSerifMode) {
        originalTextHeight = await estimateTextBoxHeight(originalPatch);
      }

      // イラスト修正時はテキストを先頭に（タスクを先に伝えて指示を通じやすくする）
      const singleContents = isSerifMode
        ? [
            { inlineData: { data: originalPatch.toString('base64'), mimeType: 'image/png' } },
            { inlineData: { data: maskPatchBinarized.toString('base64'), mimeType: 'image/png' } },
            { text: inpaintPrompt }
          ]
        : [
            { text: inpaintPrompt },
            { inlineData: { data: originalPatch.toString('base64'), mimeType: 'image/png' } },
            { inlineData: { data: maskPatchBinarized.toString('base64'), mimeType: 'image/png' } }
          ];
      console.log('[Inpaint] Gemini API呼び出し開始（single）');
      const patchBuffer = await generatePanelImageWithGemini(singleContents);
      console.log(`[Inpaint] Gemini API応答（single）: ${Date.now() - t0}ms`);
      if (!patchBuffer) {
        return res.status(500).json({ error: 'Inpaintに失敗しました。' });
      }
      const patchMeta = await sharp(patchBuffer).metadata();
      let patchToComposite = patchBuffer;
      if (patchMeta.width !== globalBox.width || patchMeta.height !== globalBox.height) {
        patchToComposite = await sharp(patchBuffer)
          .resize(globalBox.width, globalBox.height, { fit: 'cover' })
          .png()
          .toBuffer();
      }

      // イラスト修正: マスク外は元画像を維持（AIの色ずれを防ぐ）
      if (inpaintMode === 'illustration') {
        patchToComposite = await blendInpaintPatchWithMask(originalPatch, patchToComposite, maskPatchBinarized, { featherPx: edgeFeatherPx });
      }

      // セリフモードで、生成結果の文字が小さすぎる場合はパッチ内でズームしてから貼り戻す
      if (isSerifMode && originalTextHeight) {
        const newTextHeight = await estimateTextBoxHeight(patchToComposite);
        if (newTextHeight && newTextHeight < originalTextHeight * 0.85) {
          const targetW = globalBox.width;
          const targetH = globalBox.height;
          const scale = Math.min(originalTextHeight / newTextHeight, 1.8);
          const scaledW = Math.max(targetW, Math.round(targetW * scale));
          const scaledH = Math.max(targetH, Math.round(targetH * scale));

          try {
            const enlarged = await sharp(patchToComposite)
              .resize(scaledW, scaledH, {
                fit: 'contain',
                background: { r: 255, g: 255, b: 255, alpha: 0 }
              })
              .png()
              .toBuffer();

            const leftCrop = Math.max(0, Math.floor((scaledW - targetW) / 2));
            const topCrop = Math.max(0, Math.floor((scaledH - targetH) / 2));

            patchToComposite = await sharp(enlarged)
              .extract({ left: leftCrop, top: topCrop, width: targetW, height: targetH })
              .png()
              .toBuffer();
          } catch (e) {
            console.warn('セリフ拡大処理（single）に失敗:', e.message);
          }
        }
      }

      finalStripBuffer = await sharp(originalBuffer)
        .composite([{ input: patchToComposite, top: globalBox.top, left: globalBox.left }])
        .png()
        .toBuffer();
      }
    }

    // 提案B: セリフは元画像に含まれており、Inpaint後もそのまま（オーバーレイ不要）
    const filename = `${date}-inpaint-${Date.now()}.png`;
    const { absolutePath: outPathInpaintStrip, relativePath: savedPathInpaintStrip } = getGeneratedPathForDate(date, filename);
    fs.writeFileSync(outPathInpaintStrip, finalStripBuffer);

    for (const p of panelsToUpdate) {
      await run(`
        UPDATE panels SET image_path = ?, previous_image_path = ?, status = 'generated'
        WHERE comic_date = ? AND panel_number = ?
      `, [savedPathInpaintStrip, undoFilename || null, date, p.panel_number]);
    }

    const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const updatedPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    console.log(`[Inpaint] 完了: ${Date.now() - t0}ms`);
    res.json({ ...updatedComic, panels: updatedPanels });
  } catch (err) {
    console.error('Inpaintエラー:', err);
    res.status(500).json({ error: 'Inpaintに失敗しました。', details: err.message });
  }
});

// コマ Undo（再生成・Inpaint 前の画像に戻す）。4コマ1枚または同一ストリップの場合はそのストリップ全パネルを一括で戻す
app.post('/api/comics/:date/panels/:num/undo', async (req, res) => {
  const { date, num } = req.params;
  const panelNum = parseInt(num, 10);

  try {
    const panel = await get('SELECT image_path, previous_image_path FROM panels WHERE comic_date = ? AND panel_number = ?', [date, panelNum]);
    if (!panel) {
      return res.status(404).json({ error: 'コマが見つかりません。' });
    }
    if (!panel.previous_image_path) {
      return res.status(400).json({ error: '元に戻す画像がありません。再生成またはInpaint実行後にのみUndoできます。' });
    }
    const undoPath = path.join(GENERATED_DIR, panel.previous_image_path);
    if (!fs.existsSync(undoPath)) {
      return res.status(404).json({ error: 'Undo用の画像ファイルが見つかりません。' });
    }

    const allPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    const isCombined = allPanels.length >= 2 && allPanels.every(p => p.image_path === (allPanels[0]?.image_path));
    const stripPanels = allPanels.filter(p => p.image_path === panel.image_path);
    const isStrip = stripPanels.length >= 2;

    if (isCombined) {
      for (let i = 1; i <= allPanels.length; i++) {
        await run(`
          UPDATE panels SET image_path = ?, previous_image_path = NULL, status = 'generated'
          WHERE comic_date = ? AND panel_number = ?
        `, [panel.previous_image_path, date, i]);
      }
    } else if (isStrip) {
      for (const p of stripPanels) {
        await run(`
          UPDATE panels SET image_path = ?, previous_image_path = NULL, status = 'generated'
          WHERE comic_date = ? AND panel_number = ?
        `, [panel.previous_image_path, date, p.panel_number]);
      }
    } else {
      await run(`
        UPDATE panels SET image_path = ?, previous_image_path = NULL, status = 'generated'
        WHERE comic_date = ? AND panel_number = ?
      `, [panel.previous_image_path, date, panelNum]);
    }

    const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const updatedPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    res.json({ ...updatedComic, panels: updatedPanels });
  } catch (err) {
    console.error('Undoエラー:', err);
    res.status(500).json({ error: 'Undoに失敗しました。', details: err.message });
  }
});

// コマステータス更新
app.post('/api/comics/:date/panels/:num/status', async (req, res) => {
  const { date, num } = req.params;
  const { status } = req.body;
  const panelNum = parseInt(num, 10);

  try {
    await run(`
      UPDATE panels SET status = ?
      WHERE comic_date = ? AND panel_number = ?
    `, [status, date, panelNum]);

    const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const allPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    res.json({ ...updatedComic, panels: allPanels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ステータス更新に失敗しました。' });
  }
});

// === Export API ===

// 結合画像をサーバーで生成してダウンロード
// クエリ ?layout=2x2 のときは4コマを2x2で結合（右が前のコマ・左が後のコマ＝日本の漫画の読順）
app.get('/api/comics/:date/export', async (req, res) => {
  const { date } = req.params;
  const layout2x2 = req.query.layout === '2x2';

  try {
    const panels = await all(
      'SELECT * FROM panels WHERE comic_date = ? AND image_path IS NOT NULL ORDER BY panel_number',
      [date]
    );

    if (panels.length === 0) {
      return res.status(400).json({ error: '生成済みのコマがありません。' });
    }

    const uniquePaths = [...new Set(panels.map(p => p.image_path).filter(Boolean))];
    const firstPath = path.join(GENERATED_DIR, panels[0].image_path);

    if (!fs.existsSync(firstPath)) {
      return res.status(400).json({ error: '画像ファイルが見つかりません。' });
    }

    // 4コマ1枚で生成している場合（全パネル同一ファイル）はそのまま返す
    if (uniquePaths.length === 1) {
      const outputBuffer = fs.readFileSync(firstPath);
      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition', `attachment; filename="comic-${date}.png"`);
      return res.send(outputBuffer);
    }

    // 複数ファイルを結合
    const panelImages = panels.map(p => path.join(GENERATED_DIR, p.image_path)).filter(p => fs.existsSync(p));
    if (panelImages.length === 0) {
      return res.status(400).json({ error: '画像ファイルが見つかりません。' });
    }
    const panelBuffers = await Promise.all(panelImages.map(p => sharp(p).toBuffer()));
    const panelWidth = PANEL_SIZE;
    const panelHeight = PANEL_SIZE;

    if (layout2x2 && panelBuffers.length === 4) {
      // 2x2レイアウト・日本の読順（右→左、上→下）: 右列=1,2コマ目・左列=3,4コマ目
      // 読順: 右列上(1)→右列下(2)→左列上(3)→左列下(4)。left=0が左、left=panelWidthが右。
      const composite = [
        { input: panelBuffers[0], top: 0, left: panelWidth },   // 右・上 = 1コマ目
        { input: panelBuffers[1], top: panelHeight, left: panelWidth }, // 右・下 = 2コマ目
        { input: panelBuffers[2], top: 0, left: 0 },          // 左・上 = 3コマ目
        { input: panelBuffers[3], top: panelHeight, left: 0 }  // 左・下 = 4コマ目
      ];
      const outputBuffer = await sharp({
        create: {
          width: panelWidth * 2,
          height: panelHeight * 2,
          channels: 4,
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        }
      })
        .composite(composite)
        .png()
        .toBuffer();
      res.set('Content-Type', 'image/png');
      res.set('Content-Disposition', `attachment; filename="comic-${date}-2x2.png"`);
      return res.send(outputBuffer);
    }

    // 縦に結合（従来どおり）
    const composite = panelBuffers.map((buf, i) => ({
      input: buf,
      top: i * panelHeight,
      left: 0
    }));
    const outputBuffer = await sharp({
      create: {
        width: panelWidth,
        height: panelHeight * panelBuffers.length,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .composite(composite)
      .png()
      .toBuffer();

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="comic-${date}.png"`);
    res.send(outputBuffer);
  } catch (err) {
    console.error('エクスポートエラー:', err);
    res.status(500).json({ error: 'エクスポートに失敗しました。', details: err.message });
  }
});

// 出力フォルダに保存（複数画像対応）（outputUpload は lib/multer より import）
app.post('/api/comics/:date/save', outputUpload.array('images', 10), async (req, res) => {
  try {
    const { date } = req.params;

    // 日付形式のバリデーション
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
      return res.status(400).json({ error: '無効な日付形式です。YYYY-MM-DD形式で指定してください。' });
    }

    const files = req.files || [];

    if (files.length === 0) {
      return res.status(400).json({ error: '画像ファイルがありません。' });
    }

    const savedPaths = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // 元のファイル名から拡張子を取得（なければ.pngをデフォルト）
        const ext = path.extname(file.originalname) || '.png';
        const filename = `comic-${date}-${i + 1}${ext}`;
        const filepath = path.join(OUTPUT_DIR, filename);

        // パストラバーサル攻撃の防止
        const normalizedPath = path.normalize(filepath);
        if (!normalizedPath.startsWith(OUTPUT_DIR)) {
          throw new Error('無効なファイルパスです。');
        }

        // メモリからファイルに書き込み
        fs.writeFileSync(filepath, file.buffer);
        savedPaths.push(filepath);
      }
    } catch (writeErr) {
      // 書き込み失敗時: 既に保存したファイルをクリーンアップ
      for (const savedPath of savedPaths) {
        try {
          fs.unlinkSync(savedPath);
        } catch (cleanupErr) {
          console.error('クリーンアップエラー:', cleanupErr);
        }
      }
      throw writeErr;
    }

    res.json({ ok: true, paths: savedPaths, count: savedPaths.length });
  } catch (err) {
    console.error('保存エラー:', err);
    res.status(500).json({ error: '保存に失敗しました。', details: err.message });
  }
});

// 診断用エンドポイント: セリフ表示のデータフローを検証
app.get('/api/comics/:date/diagnose-serif', async (req, res) => {
  try {
    const { date } = req.params;
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const panels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);

    if (!comic) {
      return res.json({ error: '漫画が見つかりません', date });
    }

    // 1. summaryの状態を確認
    const summaryRaw = comic.summary;
    const summaryDiag = {
      exists: !!summaryRaw,
      type: typeof summaryRaw,
      length: summaryRaw?.length || 0,
      preview: summaryRaw ? summaryRaw.substring(0, 500) : null,
      isEmpty: !summaryRaw || summaryRaw === '[]' || summaryRaw === '""'
    };

    // 2. summaryをパースして各パネルのcontentを抽出
    let parsedSummary = [];
    let parseError = null;
    try {
      if (summaryRaw) {
        const parsed = JSON.parse(summaryRaw);
        parsedSummary = Array.isArray(parsed) ? parsed : (parsed?.panels || []);
      }
    } catch (e) {
      parseError = e.message;
    }

    // 3. 各パネルのセリフ検出をシミュレート
    const serifPattern = /【([^【】：:]+?)[：:]([^【】]+?)\s*】/g;
    const panelAnalysis = parsedSummary.map((item, idx) => {
      const content = String(item.content || item.description || '');
      const serifs = [];
      let m;
      const re = new RegExp(serifPattern.source, 'g');
      while ((m = re.exec(content)) !== null) {
        serifs.push({ speaker: m[1], text: m[2] });
      }
      return {
        panel: item.panel,
        contentLength: content.length,
        contentPreview: content.substring(0, 200),
        aspect: item.aspect,
        serifCount: serifs.length,
        serifs: serifs
      };
    });

    // 4. DBのpanelsとsummaryのマッピング確認
    const panelMapping = panels.map(p => {
      const summaryItem = parsedSummary.find(s => Number(s.panel) === Number(p.panel_number));
      return {
        panel_number: p.panel_number,
        image_path: p.image_path,
        status: p.status,
        hasSummaryMatch: !!summaryItem,
        summaryPanel: summaryItem?.panel
      };
    });

    // 5. allSamePathの判定
    const imagePaths = panels.map(p => p.image_path).filter(Boolean);
    const uniquePaths = [...new Set(imagePaths)];
    const allSamePath = uniquePaths.length === 1 && imagePaths.length > 0;

    res.json({
      date,
      summary: summaryDiag,
      parseError,
      panelAnalysis,
      panelMapping,
      panelsInDB: panels.length,
      allSamePath,
      uniqueImagePaths: uniquePaths,
      totalSerifsDetected: panelAnalysis.reduce((sum, p) => sum + p.serifCount, 0),
      recommendation: !summaryRaw
        ? '「準備」タブで構成を保存してください'
        : panelAnalysis.every(p => p.serifCount === 0)
        ? 'セリフが検出されません。【発話者：セリフ】形式で記述してください'
        : !allSamePath
        ? 'パネルが異なる画像を使用しています。セリフオーバーレイは同一画像の場合のみ適用されます'
        : 'データは正常です。ブラウザコンソールでエラーを確認してください'
    });
  } catch (err) {
    console.error('診断エラー:', err);
    res.status(500).json({ error: '診断に失敗しました', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`RAIU Agent server running on http://localhost:${PORT}`);
});
