/**
 * テーマ提案用AIプロバイダー（Gemini / Perplexity）
 * テーマ・エピソード概要の生成に使用
 */
import path from 'path';
import { getTextModel } from './imageGeneration.js';
import { getSetting } from '../lib/config.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);

/**
 * テーマ提案のテキストを生成する
 * @param {string} prompt - プロンプト
 * @param {'gemini'|'perplexity'} provider - 使用するプロバイダー
 * @returns {Promise<string>} 生成されたテキスト
 */
export async function generateThemeText(prompt, provider) {
  const p = (provider || 'gemini').toLowerCase();
  if (p === 'perplexity') {
    return generateWithPerplexity(prompt);
  }
  return generateWithGemini(prompt);
}

async function generateWithGemini(prompt) {
  const model = getTextModel();
  const result = await model.generateContent(prompt);
  return (result?.response?.text() || '').trim();
}

async function generateWithPerplexity(prompt) {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY が設定されていません (.env に追加してください)');
  }

  const modelName = process.env.PERPLEXITY_MODEL || 'sonar';
  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2048,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    let errMsg = `Perplexity API エラー (${res.status})`;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed.error?.message) errMsg = parsed.error.message;
    } catch (_) {}
    throw new Error(errMsg);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim() || '';
  if (!text) {
    throw new Error('Perplexity から空の応答が返りました');
  }
  return text;
}

/**
 * 現在のテーマ提案プロバイダーを取得
 * @returns {Promise<'gemini'|'perplexity'>}
 */
export async function getThemeProvider() {
  const fromSetting = await getSetting('theme_provider');
  const p = (fromSetting || process.env.THEME_PROVIDER || 'gemini').toLowerCase();
  return p === 'perplexity' ? 'perplexity' : 'gemini';
}
