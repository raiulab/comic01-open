import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPanelCompositionType,
  getContentWithoutCompositionMark,
  getPromptSafePanelContent
} from './imageGeneration.js';

test('新しい構図表記 〈構図：...〉 を文字だけコマとして認識する', () => {
  assert.equal(getPanelCompositionType('〈構図：白地に黒字で文字だけ〉\nあるひのできごと。'), 'text_white');
});

test('新しい構図表記 〈構図：...〉 を本文から除去できる', () => {
  assert.equal(
    getContentWithoutCompositionMark('〈構図：アップショット〉\nこうえんであそぶ。'),
    'こうえんであそぶ。'
  );
});

test('画像生成向けの内容では話者名を除去してセリフ本文だけを残す', () => {
  const result = getPromptSafePanelContent('〈構図：アップショット〉\n【おとな：もういいかーい】【子供：まあだだよー】');
  assert.equal(result.body, 'もういいかーい\nまあだだよー');
  assert.deepEqual(result.serifTexts, ['もういいかーい', 'まあだだよー']);
  assert.equal(result.normalizedContent.startsWith('〈構図：アップショット〉'), true);
});
