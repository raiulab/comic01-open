import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestStructurePrompt } from './structurePrompt.js';

test('AIによる構成プロンプトが厳密型テンプレートを要求する', () => {
  const prompt = buildSuggestStructurePrompt({
    panelCount: 4,
    theme: '焼け跡で見つけた茶碗',
    episodeSummary: '子供が焼け跡で茶碗を見つけて大人に知らせる。',
    conceptContext: '',
    dateContextBlock: '',
    futureDateInstruction: '',
    stageFacilitiesBlock: '',
    temporalContext: '',
    characterBlock: '',
    year: 2026,
    month: 3,
    day: 7,
    conceptConfigForStructure: null
  });

  assert.match(prompt, /人物配置：/);
  assert.match(prompt, /向き：/);
  assert.match(prompt, /動作：/);
  assert.match(prompt, /セリフ：/);
  assert.match(prompt, /右＝/);
  assert.match(prompt, /左＝/);
  assert.match(prompt, /右の.+【.+：.+】/);
  assert.match(prompt, /左の.+【.+：.+】/);
});

test('AIによる構成プロンプトのJSON例が厳密型テンプレートになっている', () => {
  const prompt = buildSuggestStructurePrompt({
    panelCount: 4,
    theme: '焼け跡で見つけた茶碗',
    episodeSummary: '子供が焼け跡で茶碗を見つけて大人に知らせる。',
    conceptContext: '',
    dateContextBlock: '',
    futureDateInstruction: '',
    stageFacilitiesBlock: '',
    temporalContext: '',
    characterBlock: '',
    year: 2026,
    month: 3,
    day: 7,
    conceptConfigForStructure: null
  });

  assert.match(prompt, /"content": "〈構図：/);
  assert.match(prompt, /人物配置：\n右＝/);
  assert.match(prompt, /向き：\n/);
  assert.match(prompt, /動作：\n/);
  assert.match(prompt, /セリフ：\n右の/);
});
