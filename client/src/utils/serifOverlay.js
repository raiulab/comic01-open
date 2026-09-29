/**
 * テキストを正規化（全角→半角の揺れを吸収）
 * @param {string} text
 * @returns {string}
 */
function normalizeForParsing(text) {
  return text
    // 全角括弧→半角
    .replace(/【/g, '[')
    .replace(/】/g, ']')
    .replace(/「/g, '"')
    .replace(/」/g, '"')
    // 全角コロン→半角
    .replace(/：/g, ':')
    // 全角スペース→半角
    .replace(/　/g, ' ');
}

export function normalizeCompositionNotation(content) {
  if (content == null || typeof content !== 'string') return '';
  return content
    .normalize('NFC')
    .replace(/構図([〈《［\[])\s*構図[：:]\s*/g, '$1構図：')
    .replace(/([〈《［\[])\s*構図[：:]\s*構図[：:]\s*/g, '$1構図：');
}

/**
 * シナリオの content から【発話者：セリフ】または [発話者: セリフ] 形式のセリフを抽出する
 * 全角・半角の括弧・コロン両方に対応、より柔軟なマッチング
 * @param {string} content - コマの構成内容
 * @returns {{ speaker: string, text: string }[]}
 */
export function parseSerifFromContent(content) {
  if (content == null || typeof content !== 'string') {
    console.log('[parseSerifFromContent] 空または非文字列:', content);
    return [];
  }
  // Unicode 正規化（NFC）とトリムで、環境差によるマッチ漏れを防ぐ
  content = normalizeCompositionNotation(content).trim();
  if (!content) return [];

  const results = [];
  const seenMatches = new Set(); // 重複チェック用
  let matchCount = 0;

  // 構図の形式を除外するため、〈構図：〜〉 / 構図〈構図：〜〉 を事前に除去
  // 構図の形式はセリフとして誤認識されないようにする
  // パターン: 「〈構図：説明〉」「構図〈構図：説明〉」など
  const contentWithoutComposition = content
    .replace(/(?:構図)?[〈《].*?[〉》]/g, '')
    .replace(/(?:構図)?[［\[]\s*(?:構図[：:])?[^\］\]]*[］\]]/g, '');

  // 正規化したテキストでもマッチを試行
  const originalContent = contentWithoutComposition;
  const normalizedContent = normalizeForParsing(contentWithoutComposition);

  // パターン定義（【】で囲まれた部分のみセリフとして認識。「」は構成の説明に使われるため対象外）
  // 閉じ括弧の直前に改行・スペースがあってもマッチするよう \s* を許容
  const patterns = [
    // パターン1: 【発話者：セリフ】形式（唯一のセリフ形式）
    { re: /【([^【】：:]+?)[：:]([^【】]+?)\s*】/g, name: '全角【】' },
    // パターン2: [発話者:セリフ]形式（半角括弧で書かれた場合）
    { re: /\[([^\[\]：:]+?)[：:]([^\[\]]+?)\s*\]/g, name: '半角[]' },
    // パターン3: 正規化後の[発話者:セリフ]（【】が半角に変換された後）
    { re: /\[([^\[\]:]+?):([^\[\]]+?)\s*\]/g, name: '正規化後[]', useNormalized: true },
  ];

  for (const { re, name, useNormalized, reversed } of patterns) {
    const targetContent = useNormalized ? normalizedContent : originalContent;
    re.lastIndex = 0; // リセット
    let m;
    while ((m = re.exec(targetContent)) !== null) {
      // reversed の場合は発話者とセリフの順序が逆
      const speaker = reversed ? (m[2] || '').trim() : (m[1] || '').trim();
      const text = reversed ? (m[1] || '').trim() : (m[2] || '').trim();

      // 発話者名が長すぎる場合はスキップ（誤マッチ防止）
      if (speaker.length > 20) continue;
      // セリフが空または短すぎる場合はスキップ
      if (!text || text.length < 1) continue;

      // 重複判定は空白を正規化した key で行う（全角スペース／半角スペースの差で同一セリフが二重に認識されるのを防ぐ）
      const normalizedKey = `${speaker}:${text.replace(/\s+/g, ' ').trim()}`;
      if (!seenMatches.has(normalizedKey)) {
        seenMatches.add(normalizedKey);
        matchCount++;
        results.push({ speaker, text });
      }
    }
  }

  // 括弧があるのにマッチしなかった場合のみデバッグログ（地の文のみの content では出さない）
  if (matchCount === 0) {
    const hasFullBracket = content.includes('【') || content.includes('】');
    const hasHalfBracket = content.includes('[') || content.includes(']');
    if (hasFullBracket || hasHalfBracket) {
      console.log('[parseSerifFromContent] マッチなし（括弧あり）。content:', content.substring(0, 200), {
        hasFullBracket,
        hasHalfBracket,
        contentLength: content.length
      });
    }
  }

  return results;
}

/**
 * セリフが検出できるかテスト（UI表示用）
 * @param {string} content
 * @returns {{ detected: boolean, count: number, serifs: { speaker: string, text: string }[] }}
 */
export function testSerifDetection(content) {
  const serifs = parseSerifFromContent(content);
  return {
    detected: serifs.length > 0,
    count: serifs.length,
    serifs
  };
}

/**
 * 構成（summary）JSON から、指定グループのコマ順の content・aspect を返す。
 * summary は配列 [ { panel, content, aspect } ] または { panels: [...] }。panel は 1 始まり。
 */
export function getSummaryPanelsForGroup(summaryJson, group) {
  if (!group?.length) return [];
  if (summaryJson === undefined || summaryJson === null) return [];
  if (typeof summaryJson === 'object') summaryJson = JSON.stringify(summaryJson);
  const str = typeof summaryJson === 'string' ? summaryJson.trim() : '';
  if (!str || str === '[]' || str === '""') return [];
  let arr = [];
  try {
    const parsed = JSON.parse(str);
    arr = Array.isArray(parsed) ? parsed : (parsed?.panels || []);
  } catch (e) {
    console.warn('[getSummaryPanelsForGroup] JSONパース失敗:', e.message);
    return [];
  }
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return group.map((g) => {
    const panelNum = Number(g.panel_number);
    const p = arr.find((item) => {
      const itemPanel = Number(item.panel ?? item.panel_number ?? 0);
      return itemPanel === panelNum;
    });
    const content = p ? String(p.content ?? p.description ?? '').trim() : '';
    const aspect = p?.aspect || 'square';
    return { content, aspect };
  });
}

/**
 * アスペクトから高さ比率（幅1あたり）を返す（3択のみ）
 */
function aspectToHeightRatio(aspect) {
  // 3つの比率のみ
  if (aspect === 'landscape') return 1 / 4;
  if (aspect === 'portrait') return 4 / 1;
  if (aspect === 'square') return 1;

  // フォールバック（デフォルトは正方形）
  return 1;
}

/**
 * 縦に並んだNコマ画像の各コマのY範囲（px）を算出する
 * 【提案A】縦横比3種類（landscape / square / portrait）に統一し、
 * サーバー側の結合画像生成と同じ比率で境界を計算する。
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {('landscape'|'square'|'portrait')[]} aspects - 上から順に各コマのアスペクト
 * @returns {{ y0: number, y1: number, height: number }[]}
 */
export function getPanelBounds(imageWidth, imageHeight, aspects) {
  if (!aspects?.length || imageHeight <= 0) {
    console.warn('[getPanelBounds] 無効なパラメータ:', { aspectsLength: aspects?.length, imageHeight });
    return [];
  }
  const n = aspects.length;
  // サーバー generateCombinedPanelImage と同じ比率: landscape=1/4, square=1, portrait=4（高さ比）
  const ratios = aspects.map((a) => aspectToHeightRatio(a));
  const sum = ratios.reduce((s, r) => s + r, 0) || n;
  const bounds = [];
  let currentY = 0;
  for (let i = 0; i < n; i++) {
    const height = i === n - 1
      ? imageHeight - currentY
      : Math.round(imageHeight * (ratios[i] / sum));
    bounds.push({
      y0: currentY,
      y1: currentY + height,
      height
    });
    currentY += height;
  }
  return bounds;
}

/**
 * 1コマ内に吹き出しとテキストを描画する（参考画像に基づくシンプル版）
 * 特徴:
 * - 角丸四角形の吹き出し
 * - 下向き三角形のしっぽ（吹き出しと一体化）
 * - セリフのみ表示（発話者名は省略）
 * - コマ上部に配置
 */
function drawBubbleAndText(ctx, panelY0, panelHeight, panelWidth, lines, options = {}, panelIndex = 0) {
  const { padding = 12, fontSize = 18, lineHeight = 1.4, bubblePadding = 10 } = options;

  if (!lines.length) {
    console.log('[drawBubbleAndText] lines が空、スキップ');
    return;
  }

  console.log(`[drawBubbleAndText] 開始: panelIndex=${panelIndex}, panelY0=${panelY0}, panelHeight=${panelHeight}, lines=${lines.length}件`);

  // 【提案D】フォントサイズ上限18・下限12（大きすぎるフォントを抑える）
  const FONT_SIZE_MAX = 18;
  const FONT_SIZE_MIN = 12;
  const adaptiveFontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.floor(panelHeight / 18)));
  const actualFontSize = fontSize || adaptiveFontSize;

  // 日本語対応のゴシック系太字フォント
  const font = `bold ${actualFontSize}px "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "MS PGothic", sans-serif`;
  ctx.font = font;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  const maxBubbleWidth = Math.floor(panelWidth * 0.42);
  const seenSerifs = new Set();
  const bubblesToDraw = [];

  // セリフをテキスト行に分割
  for (const { speaker, text } of lines) {
    const full = (text || '').trim();
    if (!full) continue;

    // 重複チェック
    const serifKey = `${speaker || ''}:${text || ''}`;
    if (seenSerifs.has(serifKey)) continue;
    seenSerifs.add(serifKey);

    const textLines = [];
    const paragraphs = full.split(/\n/);
    for (const block of paragraphs) {
      let remaining = block.trim();
      if (!remaining) continue;
      while (remaining.length > 0) {
        let width = ctx.measureText(remaining).width;
        if (width <= maxBubbleWidth - bubblePadding * 2) {
          textLines.push(remaining);
          break;
        }
        let low = 0;
        let high = remaining.length;
        while (high - low > 1) {
          const mid = Math.floor((low + high) / 2);
          width = ctx.measureText(remaining.slice(0, mid)).width;
          if (width <= maxBubbleWidth - bubblePadding * 2) low = mid;
          else high = mid;
        }
        textLines.push(remaining.slice(0, low || 1));
        remaining = remaining.slice(low || 1);
      }
    }
    if (textLines.length > 0) bubblesToDraw.push({ textLines });
  }

  if (bubblesToDraw.length === 0) return;

  // 日本の漫画は右から左へ読むため、先の台詞を右・後の台詞を左に配置
  const leftBubbles = [];
  const rightBubbles = [];
  bubblesToDraw.forEach((b, i) => {
    if (i % 2 === 0) rightBubbles.push(b);  // 先の発言 → 右
    else leftBubbles.push(b);                // 後の発言 → 左
  });

  const lineHeightPx = actualFontSize * lineHeight;
  let leftY = panelY0 + padding;
  let rightY = panelY0 + padding;

  // 【提案H】吹き出しを描画する関数（スタイル0=角丸四角, 1=楕円, 2=雲形）
  const drawBubble = (bubbleX, bubbleY, textLines, isLeft, bubbleStyle = 0) => {
    const bubbleHeight = textLines.length * lineHeightPx + bubblePadding * 2;
    const bubbleWidth = Math.min(
      maxBubbleWidth,
      Math.max(...textLines.map((t) => ctx.measureText(t).width)) + bubblePadding * 2
    );

    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;

    const r = 8;
    const tailSize = 14;
    const tailSpread = 8;
    const tailCenterX = isLeft ? bubbleX + bubbleWidth * 0.7 : bubbleX + bubbleWidth * 0.3;
    const tailY = bubbleY + bubbleHeight;
    const tailEndX = isLeft ? tailCenterX + tailSize * 0.5 : tailCenterX - tailSize * 0.5;

    if (bubbleStyle === 1) {
      // 楕円形
      const rx = bubbleWidth / 2;
      const ry = bubbleHeight / 2;
      const cx = bubbleX + bubbleWidth / 2;
      const cy = bubbleY + bubbleHeight / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tailCenterX - tailSpread, tailY);
      ctx.lineTo(tailEndX, tailY + tailSize);
      ctx.lineTo(tailCenterX + tailSpread, tailY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (bubbleStyle === 2) {
      // 雲形（角丸を大きく）
      const R = 12;
      ctx.beginPath();
      ctx.moveTo(bubbleX + R, bubbleY);
      ctx.quadraticCurveTo(bubbleX + bubbleWidth / 2, bubbleY - 2, bubbleX + bubbleWidth - R, bubbleY);
      ctx.quadraticCurveTo(bubbleX + bubbleWidth + 2, bubbleY + bubbleHeight / 2, bubbleX + bubbleWidth - R, bubbleY + bubbleHeight);
      ctx.lineTo(tailCenterX + tailSpread, tailY);
      ctx.lineTo(tailEndX, tailY + tailSize);
      ctx.lineTo(tailCenterX - tailSpread, tailY);
      ctx.lineTo(bubbleX + R, bubbleY + bubbleHeight);
      ctx.quadraticCurveTo(bubbleX - 2, bubbleY + bubbleHeight / 2, bubbleX + R, bubbleY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      // スタイル0: 角丸四角 + 下しっぽ
      ctx.beginPath();
      ctx.moveTo(bubbleX + r, bubbleY);
      ctx.lineTo(bubbleX + bubbleWidth - r, bubbleY);
      ctx.quadraticCurveTo(bubbleX + bubbleWidth, bubbleY, bubbleX + bubbleWidth, bubbleY + r);
      ctx.lineTo(bubbleX + bubbleWidth, bubbleY + bubbleHeight - r);
      ctx.quadraticCurveTo(bubbleX + bubbleWidth, bubbleY + bubbleHeight, bubbleX + bubbleWidth - r, bubbleY + bubbleHeight);
      ctx.lineTo(tailCenterX + tailSpread, tailY);
      ctx.lineTo(tailEndX, tailY + tailSize);
      ctx.lineTo(tailCenterX - tailSpread, tailY);
      ctx.lineTo(bubbleX + r, bubbleY + bubbleHeight);
      ctx.quadraticCurveTo(bubbleX, bubbleY + bubbleHeight, bubbleX, bubbleY + bubbleHeight - r);
      ctx.lineTo(bubbleX, bubbleY + r);
      ctx.quadraticCurveTo(bubbleX, bubbleY, bubbleX + r, bubbleY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(tailCenterX - tailSpread + 2, tailY);
      ctx.lineTo(tailCenterX + tailSpread - 2, tailY);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = '#000000';
    ctx.textAlign = 'left';
    let ty = bubbleY + bubblePadding;
    for (const line of textLines) {
      ctx.fillText(line, bubbleX + bubblePadding, ty);
      ty += lineHeightPx;
    }

    return bubbleHeight + tailSize + 8;
  };

  const maxLen = Math.max(leftBubbles.length, rightBubbles.length);
  for (let i = 0; i < maxLen; i++) {
    const bubbleStyle = (panelIndex + i) % 3;
    if (i < leftBubbles.length) {
      const b = leftBubbles[i];
      const h = drawBubble(padding, leftY, b.textLines, true, bubbleStyle);
      leftY += h;
    }
    if (i < rightBubbles.length) {
      const b = rightBubbles[i];
      const h = drawBubble(panelWidth - padding - maxBubbleWidth, rightY, b.textLines, false, bubbleStyle);
      rightY += h;
    }
  }

  console.log(`[drawBubbleAndText] 描画完了: ${bubblesToDraw.length}件`);
}

/**
 * 画像とコマ別セリフを受け取り、キャンバスに描画してから吹き出し・テキストをオーバーレイする
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLImageElement} image
 * @param {{ y0: number, y1: number, height: number }[]} panelBounds
 * @param {{ speaker: string, text: string }[][]} panelDialogueLines - 各コマのセリフ配列
 */
export async function drawSerifOverlay(canvas, image, panelBounds, panelDialogueLines, options = {}) {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.error('[drawSerifOverlay] canvas context 取得失敗');
      return;
    }
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    console.log(`[drawSerifOverlay] 開始: 画像サイズ=${w}x${h}, コマ数=${panelBounds.length}, セリフ配列数=${panelDialogueLines.length}`);
    if (panelBounds.length !== panelDialogueLines.length) {
      console.warn(`[drawSerifOverlay] 警告: パネル境界数(${panelBounds.length})とセリフ配列数(${panelDialogueLines.length})が一致しません`);
    }
    panelBounds.forEach((bound, i) => {
      console.log(`[drawSerifOverlay] パネル${i + 1}: y0=${bound.y0}, y1=${bound.y1}, height=${bound.height}, セリフ数=${panelDialogueLines[i]?.length || 0}`);
    });
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(image, 0, 0);
    const panelWidth = w;
    let drawnCount = 0;
    for (let i = 0; i < panelBounds.length; i++) {
      const bound = panelBounds[i];
      const lines = panelDialogueLines[i] || [];
      if (lines.length > 0) {
        console.log(`[drawSerifOverlay] コマ${i + 1}にセリフを描画: y0=${bound.y0}, height=${bound.height}, セリフ数=${lines.length}`);
        drawBubbleAndText(ctx, bound.y0, bound.height, panelWidth, lines, options, i);
        drawnCount++;
      } else {
        console.log(`[drawSerifOverlay] コマ${i + 1}にはセリフがありません`);
      }
    }
    console.log(`[drawSerifOverlay] 完了: ${drawnCount}/${panelBounds.length}コマに吹き出しを描画`);
  } catch (err) {
    console.warn('[serifOverlay] drawSerifOverlay エラー:', err);
    throw err;
  }
}

/**
 * 吹き出しのみをキャンバスに描画する（画像は描かず透明のまま）。
 * 表示時はこのキャンバスを画像の上に重ねることで、吹き出しが必ず前面に表示される。
 * @param {HTMLCanvasElement} canvas
 * @param {number} imageWidth
 * @param {number} imageHeight
 * @param {{ y0: number, y1: number, height: number }[]} panelBounds
 * @param {{ speaker: string, text: string }[][]} panelDialogueLines
 */
export async function drawSerifOverlayOnly(canvas, imageWidth, imageHeight, panelBounds, panelDialogueLines, options = {}) {
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const panelWidth = imageWidth;
    for (let i = 0; i < panelBounds.length; i++) {
      const bound = panelBounds[i];
      const lines = panelDialogueLines[i] || [];
      if (lines.length > 0) {
        drawBubbleAndText(ctx, bound.y0, bound.height, panelWidth, lines, options, i);
      }
    }
  } catch (err) {
    console.warn('[serifOverlay] drawSerifOverlayOnly エラー:', err);
  }
}

/**
 * 既存のキャンバスにセリフ吹き出しを追加描画する（キャンバスのリサイズなし）
 * 結合済みの画像キャンバスに対して使用
 * @param {HTMLCanvasElement} canvas - 既に画像が描画されているキャンバス
 * @param {{ y0: number, y1: number, height: number }[]} panelBounds - 各コマのY範囲
 * @param {{ speaker: string, text: string }[][]} panelDialogueLines - 各コマのセリフ配列
 * @param {Object} options - 描画オプション
 */
export async function addSerifToCanvas(canvas, panelBounds, panelDialogueLines, options = {}) {
  try {
    // フォントはシステムフォントを使用（外部フォントの読み込み待機不要）
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.error('[addSerifToCanvas] canvas context 取得失敗');
      return;
    }
    const panelWidth = canvas.width;
    let drawnCount = 0;
    console.log(`[addSerifToCanvas] 開始: キャンバスサイズ=${canvas.width}x${canvas.height}, コマ数=${panelBounds.length}`);

    for (let i = 0; i < panelBounds.length; i++) {
      const bound = panelBounds[i];
      const lines = panelDialogueLines[i] || [];
      if (lines.length > 0) {
        console.log(`[addSerifToCanvas] コマ${i + 1}にセリフを描画: y0=${bound.y0}, height=${bound.height}, セリフ数=${lines.length}`);
        drawBubbleAndText(ctx, bound.y0, bound.height, panelWidth, lines, options, i);
        drawnCount++;
      }
    }
    console.log(`[addSerifToCanvas] 完了: ${drawnCount}コマに吹き出しを描画`);
  } catch (err) {
    console.warn('[serifOverlay] addSerifToCanvas エラー:', err);
    throw err;
  }
}
