# セリフオーバーレイ デバッグガイド

## 問題: セリフが表示されない

### 確認手順

1. **ブラウザのコンソールを開く**（F12 → Console タブ）
2. **出力タブを開く**（漫画を生成済みの日付を選択）
3. コンソールに以下のログが表示されるか確認：

```
[getSummaryPanelsForGroup] 入力: ...
[getSummaryPanelsForGroup] パース成功: ...
[セリフオーバーレイ] summaryJson: ...
[セリフオーバーレイ] summaryPanels: ...
[parseSerifFromContent] マッチ1: speaker="...", text="..."
[セリフオーバーレイ] hasSerif: true/false
```

### よくある原因と解決方法

#### 1. `summaryJson` が空または undefined

**症状**: コンソールに `[getSummaryPanelsForGroup] summaryJson が空文字列` と表示

**原因**: Prepare タブで「保存」ボタンを押していない

**解決方法**:
- Prepare タブに戻る
- 構成を入力後、**必ず「保存」ボタンを押す**
- その後、生成タブで漫画を生成

---

#### 2. `summaryPanels` が空配列

**症状**: `[getSummaryPanelsForGroup] arr が空配列または配列でない` と表示

**原因**: summary の JSON 形式が期待と異なる

**確認方法**:
- コンソールで `[getSummaryPanelsForGroup] パース成功:` のログを確認
- `arrLength: 0` なら summary にデータがない

**解決方法**:
- Prepare タブで構成を再入力・保存
- または、サーバーの DB を直接確認（`comics.summary` カラム）

---

#### 3. `parseSerifFromContent` がマッチしない

**症状**: `[parseSerifFromContent] マッチなし` と表示

**原因**: セリフの記述形式が正規表現と一致していない

**確認方法**:
- コンソールで `[parseSerifFromContent] content="..."` を確認
- 実際の content に **【発話者：セリフ】** が含まれているか

**正しい形式**:
- ✅ `【子供：もういいかーい】`
- ✅ `[子供: もういいかーい]`
- ❌ `（子供：もういいかーい）` ← 全角括弧
- ❌ `【子供 もういいかーい】` ← コロンがない
- ❌ `子供：もういいかーい` ← 括弧がない

**解決方法**:
- 構成欄に **【発話者：セリフ】** 形式で記述
- 全角【】と全角コロン：を使用（推奨）
- または半角 [] と半角コロン : でも可

---

#### 4. `hasSerif: false` になっている

**症状**: `[セリフオーバーレイ] hasSerif: false` と表示

**原因**: すべてのコマで `parseSerifFromContent` が空配列を返している

**確認方法**:
- `[セリフオーバーレイ] panelDialogueLines:` を確認
- すべて `[]` なら、セリフが抽出できていない

**解決方法**:
- 上記「3. parseSerifFromContent がマッチしない」を参照

---

#### 5. `allSamePath` が false

**症状**: オーバーレイ処理自体が実行されない（ログが一切出ない）

**原因**: グループ内のパネルが異なる `image_path` を持っている

**確認方法**:
- `[セリフオーバーレイ] group:` ログで各パネルの `image_path` を確認
- すべて同じパスか確認

**解決方法**:
- 生成タブで「出力形式: 1枚に結合」を選択して再生成
- または、サーバー側で `panels_per_file` 設定を確認

---

## テスト用: セリフ抽出のテスト

ブラウザのコンソールで以下を実行して、正規表現が動作するか確認：

```javascript
// テスト用関数（serifOverlay.js から）
function testParseSerif(content) {
  const re = /[【\[]([^：:\]\n]+)[：:]([^】\]]*?)[】\]]/g;
  const results = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    results.push({ speaker: m[1].trim(), text: m[2].trim() });
  }
  return results;
}

// テスト実行
testParseSerif('公園で【子供：もういいかーい】遊んでいます。【そうべい：まあだだよー】');
// 期待結果: [{ speaker: "子供", text: "もういいかーい" }, { speaker: "そうべい", text: "まあだだよー" }]
```

---

## まとめ

セリフが表示されない場合のチェックリスト：

- [ ] Prepare タブで「保存」を押したか
- [ ] 構成欄に **【発話者：セリフ】** 形式で書いたか（全角【】と全角：）
- [ ] 生成タブで「出力形式: 1枚に結合」を選択したか
- [ ] ブラウザのコンソールでエラーが出ていないか
- [ ] `[セリフオーバーレイ] hasSerif: true` と表示されているか
