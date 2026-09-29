# セリフオーバーレイ問題の調査と修正

## 問題の概要

1. **添付画像1**: セリフが誤った位置と表示形式でオーバーレイされている
2. **添付画像2**: セリフが全く表示されていない

## 実装の流れ（2025年整理）

- **表示**: `SerifOverlayImage` が「画像＋吹き出しだけのキャンバス」の二層表示を行う。
- **データ**: 準備タブで保存した `summary`（JSON文字列: `[{ panel, content, aspect }, ...]`）を、生成・出力タブで `comic.summary` として取得。タブ切り替え時に `GET /api/comics/:date` で再取得して最新にする。
- **描画**: `getSummaryPanelsForGroup(summary, group)` → 各コマの `content` を `parseSerifFromContent` で【発話者：セリフ】抽出 → `drawSerifOverlayOnly` で吹き出しのみ描画。
- **設計**: `docs/archive/plans/serif-overlay-design.md` 参照。

## 根本原因の調査

### 可能性1: パネル境界の計算が失敗している
- **原因**: アスペクト比の複雑な計算により、パネル境界が正しく計算されていない
- **対策**: 常に等分割を使用するように変更

### 可能性2: summaryPanelsが空になっている
- **原因**: `getSummaryPanelsForGroup`関数が正しく動作していない
- **対策**: 詳細なデバッグログを追加

### 可能性3: セリフ抽出が失敗している
- **原因**: セリフ形式が正しく認識されていない
- **対策**: セリフ抽出のログを強化

## 実装した修正

### 1. パネル境界の計算をシンプル化
- **変更前**: アスペクト比に基づいて複雑な計算
- **変更後**: 常に等分割を使用（コマ数に基づいて画像を等分割）
- **ファイル**: `client/src/utils/serifOverlay.js` の `getPanelBounds` 関数

### 2. デバッグログの強化
- `getSummaryPanelsForGroup`関数に詳細なログを追加
- パネル境界計算前後のログを追加
- セリフ抽出結果のログを追加

### 3. エラーハンドリングの改善
- パネル境界とセリフ配列の数の不一致をチェック
- より詳細なエラーメッセージを表示

## デバッグ方法

ブラウザのコンソールで以下のログを確認：

1. `[getSummaryPanelsForGroup]` - summaryPanelsの取得結果
2. `[OutputTab] summaryPanels取得結果` - 各コマのcontentとaspect
3. `[OutputTab] コマNのセリフ抽出` - 各コマのセリフ抽出結果
4. `[OutputTab] パネル境界計算前` - 画像サイズとアスペクト比
5. `[getPanelBounds]` - パネル境界の計算結果
6. `[drawSerifOverlay]` - セリフオーバーレイの描画過程

## 確認すべきポイント

1. **comic.summary が入っているか**
   - 生成・出力タブを開いたときに `GET /api/comics/:date` で再取得している（App.jsx の useEffect）。
   - 準備タブで「保存」したあと、別タブから戻った場合は再取得で最新が入る。ブラウザの Network でレスポンスの `summary` に 【】 入りの content があるか確認。

2. **SerifOverlayImage に summary が渡っているか**
   - コンソールに `[SerifOverlayImage] セリフなし` と出る場合、その中の `summaryLen` が 0 でないか・`panelContents` に 【】 入りがあるか確認。

3. **summaryPanels が空でないか**
   - `getSummaryPanelsForGroup` は summary が `[]` や空文字だと `[]` を返す。`group` の `panel_number` と summary の `panel`（1始まり）が一致している必要あり。

4. **セリフが正しく抽出されているか**
   - 各コマの `content` に 【発話者：セリフ】 形式が含まれているか。半角 [ ] や全角【】の両方に対応。

5. **パネル境界が正しく計算されているか**
   - `getPanelBounds` は常に等分割。`panelBounds.length` と `panelDialogueLines.length` が一致しないと描画しない。

6. **キャンバスが画像の上に重なっているか**
   - `SerifOverlayImage` は img の上に `position: absolute` の canvas を重ねている。吹き出しだけ描画するので、画像より下に隠れることはない。

## 今後の改善案

1. **アスペクト比の扱いを簡素化**
   - セリフオーバーレイではアスペクト比を無視し、常に等分割を使用
   - これにより、セリフ表示の確実性が向上

2. **フォールバック機能の追加**
   - パネル境界の計算が失敗した場合、デフォルトの等分割を使用
   - summaryPanelsが空の場合、グループのコマ数から推測

3. **ユーザーへのフィードバック強化**
   - セリフが表示されない理由を明確に表示
   - デバッグ情報をUIに表示（開発モード）
