/**
 * 画風設定 JSON パース・選択・フォーマット
 */
import { getSetting } from '../lib/config.js';
import { getEffectiveDrawingStyle } from './concept.js';

/** 画風設定JSONの生文字列をパースし、スタイル一覧に正規化する。 */
export function parseImageStyleConfig(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { list: [], items: [] };
  }
  try {
    const root = JSON.parse(raw);
    if (!root || typeof root !== 'object') return { list: [], items: [] };
    let items = [];
    if (Array.isArray(root.styles) && root.styles.length > 0) {
      items = root.styles.map((s, i) => ({
        style_name: (s && s.style_name && String(s.style_name).trim()) || `スタイル${i + 1}`,
        ...s
      }));
    } else if (root.image_generation_prompt && typeof root.image_generation_prompt === 'object') {
      const s = root.image_generation_prompt;
      items = [{ style_name: (s.style_name && String(s.style_name).trim()) || 'スタイル1', ...s }];
    }
    const list = items.map((item) => ({ style_name: item.style_name }));
    return { list, items };
  } catch {
    return { list: [], items: [] };
  }
}

/** 選択されたスタイルオブジェクトを返す。未設定・不正の場合は null */
export function getSelectedImageStyleObject(raw, selectedStyleName) {
  const { items } = parseImageStyleConfig(raw);
  if (items.length === 0) return null;
  if (selectedStyleName && selectedStyleName.trim()) {
    const found = items.find((s) => String(s.style_name).trim() === String(selectedStyleName).trim());
    if (found) return found;
  }
  return items[0];
}

/** スタイルオブジェクトを画像生成プロンプト用のテキストに整形する。 */
export function formatImageStylePrompt(style) {
  if (!style || typeof style !== 'object') return '';
  const lines = [];
  if (style.style_name) lines.push(`【画風名】${style.style_name}`);
  const isPolaroidStyle =
    style.style_name &&
    (style.style_name.includes('polaroid photograph') || style.style_name.includes('Polaroid photograph'));
  const isHolographicStyle =
    style.style_name &&
    (style.style_name.includes('ホログラフィック風') ||
      style.style_name.toLowerCase().includes('holographic'));
  if (isPolaroidStyle) {
    lines.push(
      '【最重要】この画風は実写・写真スタイルです。イラストや絵ではなく、実際のポラロイド写真のように写実的・写真風に描くこと。'
    );
  } else if (isHolographicStyle) {
    lines.push(
      '【最重要】この画風はホログラフィック素材のフォトリアル／高品質レンダリングスタイルです。実物のホログラフィックフィルムやプラスチックのように、現実的な反射・プリズム効果・光のにじみを写真的に描くこと。'
    );
  }
  const concept = style.core_concept || style.base_concept;
  if (concept) lines.push(`【コンセプト】${concept}`);
  if (style.color) {
    lines.push(`【色】${style.color}`);
    if (style.color === '白黒' || style.color === '白黒のみ') {
      lines.push('【厳守】この画風は白黒のみで描くこと。カラー・色付けは絶対に禁止。');
    }
  }

  const attrs = style.attributes;
  if (attrs && typeof attrs === 'object') {
    if (Array.isArray(attrs.medium) && attrs.medium.length > 0) {
      lines.push(`【画材】${attrs.medium.join(', ')}`);
    }
    if (typeof attrs.medium === 'string' && attrs.medium.trim()) {
      lines.push(`【画材】${attrs.medium.trim()}`);
    }
    if (attrs.visual_characteristics && typeof attrs.visual_characteristics === 'object') {
      const vc = attrs.visual_characteristics;
      if (vc.line_work) lines.push(`【線】${vc.line_work}`);
      if (vc.perspective) lines.push(`【遠近・構図】${vc.perspective}`);
      if (vc.coloring_style) lines.push(`【彩色】${vc.coloring_style}`);
    }
    if (attrs.shading_technique) lines.push(`【陰影・質感】${attrs.shading_technique}`);
    if (attrs.color_fill) lines.push(`【彩色】${attrs.color_fill}`);
    if (attrs.line_quality) lines.push(`【線】${attrs.line_quality}`);
    if (Array.isArray(attrs.artistic_influence) && attrs.artistic_influence.length > 0) {
      lines.push(`【芸術的影響】${attrs.artistic_influence.join(', ')}`);
    }
    if (attrs.color_palette && typeof attrs.color_palette === 'object') {
      const cp = attrs.color_palette;
      const cpParts = [];
      if (cp.type) cpParts.push(cp.type);
      if (Array.isArray(cp.colors) && cp.colors.length > 0) cpParts.push(cp.colors.join(', '));
      if (cp.contrast) cpParts.push(`コントラスト: ${cp.contrast}`);
      if (cpParts.length > 0) lines.push(`【色調】${cpParts.join(' / ')}`);
    }
    if (Array.isArray(attrs.composition_elements) && attrs.composition_elements.length > 0) {
      lines.push(`【構成要素】${attrs.composition_elements.join(', ')}`);
    }
    if (attrs.overall_mood) lines.push(`【雰囲気】${attrs.overall_mood}`);
    if (attrs.background) lines.push(`【背景】${attrs.background}`);
    if (attrs.output_spec && typeof attrs.output_spec === 'object') {
      const oParts = [];
      if (attrs.output_spec.background) oParts.push(attrs.output_spec.background);
      if (attrs.output_spec.contrast) oParts.push(attrs.output_spec.contrast);
      if (attrs.output_spec.usability) oParts.push(attrs.output_spec.usability);
      if (oParts.length > 0) lines.push(`【出力仕様】${oParts.join('。')}`);
    } else if (attrs.contrast) {
      lines.push(`【出力仕様】コントラスト: ${attrs.contrast}`);
    }
  }

  const aesthetic = style.aesthetic;
  if (aesthetic && typeof aesthetic === 'object') {
    const aParts = [];
    if (aesthetic.vibe) aParts.push(aesthetic.vibe);
    if (aesthetic.detail_level) aParts.push(aesthetic.detail_level);
    if (aesthetic.complexity) aParts.push(aesthetic.complexity);
    if (aParts.length > 0) lines.push(`【雰囲気・表現】${aParts.join('。')}`);
  }

  const tech = style.technical_execution;
  if (tech && typeof tech === 'object') {
    if (tech.medium) lines.push(`【画材】${tech.medium}`);
    if (tech.shading_technique) lines.push(`【陰影・質感】${tech.shading_technique}`);
    if (tech.color_fill) lines.push(`【彩色】${tech.color_fill}`);
    if (tech.line_quality) lines.push(`【線】${tech.line_quality}`);
  }

  const outSpec = style.output_specifications;
  if (outSpec && typeof outSpec === 'object') {
    const oParts = [];
    if (outSpec.background) oParts.push(outSpec.background);
    if (outSpec.contrast) oParts.push(outSpec.contrast);
    if (outSpec.usability) oParts.push(outSpec.usability);
    if (oParts.length > 0) lines.push(`【出力仕様】${oParts.join('。')}`);
  }

  const mediumSpec = style.medium_spec;
  if (mediumSpec && typeof mediumSpec === 'object') {
    const mParts = [];
    if (mediumSpec.paper_type) mParts.push(mediumSpec.paper_type);
    if (Array.isArray(mediumSpec.drawing_tools)) mParts.push(mediumSpec.drawing_tools.join(', '));
    if (mParts.length > 0) lines.push(`【画材・紙】${mParts.join('。')}`);
  }
  const visualLogic = style.visual_logic;
  if (visualLogic && typeof visualLogic === 'object') {
    const vParts = [];
    if (visualLogic.lines) vParts.push(`線: ${visualLogic.lines}`);
    if (visualLogic.shading) vParts.push(`陰影: ${visualLogic.shading}`);
    if (visualLogic.perspective) vParts.push(`遠近: ${visualLogic.perspective}`);
    if (visualLogic.coloring_style) vParts.push(`彩色: ${visualLogic.coloring_style}`);
    if (vParts.length > 0) lines.push(`【描画ロジック】${vParts.join('。')}`);
  }

  if (style.subject_placeholder) lines.push(`【描写の参考例】${style.subject_placeholder}`);
  if (lines.length === 0) return '';
  return '【画像スタイル指示】\n' + lines.join('\n');
}

/** 画風設定（JSON）でスタイルが選択されているか */
export async function hasImageStyleConfigSelected() {
  const imageStyleConfigRaw = (await getSetting('image_style_config')) || '';
  if (!imageStyleConfigRaw.trim()) return false;
  const imageStyleSelected = (await getSetting('image_style_selected')) || '';
  const selectedStyle = getSelectedImageStyleObject(imageStyleConfigRaw, imageStyleSelected);
  if (!selectedStyle) return false;
  const block = formatImageStylePrompt(selectedStyle);
  return !!(block && block.trim());
}

/** まんが生成で選択されている画風スタイルオブジェクトを返す */
export async function getSelectedImageStyleForComic() {
  const imageStyleConfigRaw = (await getSetting('image_style_config')) || '';
  const imageStyleSelected = (await getSetting('image_style_selected')) || '';
  return getSelectedImageStyleObject(imageStyleConfigRaw, imageStyleSelected);
}

/** まんが生成用の画風文言 */
export async function getEffectiveDrawingStyleForComic() {
  const imageStyleConfigRaw = (await getSetting('image_style_config')) || '';
  const imageStyleSelected = (await getSetting('image_style_selected')) || '';
  const selectedStyle = getSelectedImageStyleObject(imageStyleConfigRaw, imageStyleSelected);
  if (selectedStyle) {
    const block = formatImageStylePrompt(selectedStyle);
    if (block && block.trim()) {
      return '【厳守】設定の「画風設定」で指定した以下の指示を厳密に守ること。\n' + block.trim();
    }
  }
  const fallback = await getEffectiveDrawingStyle();
  return '【厳守】以下の画風（シリーズ設定の art_style または画風のデフォルト）を厳密に守ること。\n' + fallback;
}
