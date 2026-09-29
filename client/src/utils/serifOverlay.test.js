import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSerifFromContent } from './serifOverlay.js';

test('新しい構図表記 〈構図：...〉 があってもセリフを正しく抽出する', () => {
  const content = '〈構図：アップショット〉\n【子供：もういいかーい】';
  assert.deepEqual(parseSerifFromContent(content), [
    { speaker: '子供', text: 'もういいかーい' }
  ]);
});

test('旧形式の 構図〈構図：...〉 もセリフ抽出時に誤認識しない', () => {
  const content = '構図〈構図：ロングショット、全体が見える〉\n【おとな：まあだだよー】';
  assert.deepEqual(parseSerifFromContent(content), [
    { speaker: 'おとな', text: 'まあだだよー' }
  ]);
});
