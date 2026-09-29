# サーバーリファクタリング設計書

**作成日**: 2026-02-16
**対象**: Phase 1（サーバー側のみ）
**目的**: `server/index.js` の分割・モジュール化による保守性向上

---

## 1. 概要・目的

### 1.1 背景

- `server/index.js` が約 4,300 行に達し、単一ファイルでの保守が困難になっている
- API ルート、画像生成、Inpaint、DB 操作、設定管理が混在しており、影響範囲の把握が難しい
- 今後の機能追加・修正をスムーズにするため、段階的なリファクタリングが必要

### 1.2 目的

- **可読性向上**: 責任ごとにファイルを分割し、1ファイルあたりの行数を抑制する
- **変更の局所化**: 特定機能の修正時に関連ファイルのみを触れるようにする
- **テスト容易性**: モジュール単位でテスト可能な形に近づける（将来の Jest 等導入を見据える）
- **リスク抑制**: 小さな単位で移行し、各ステップで動作確認を行う

### 1.3 スコープ

- **Phase 1（本設計書）**: サーバー側のリファクタリング
- **Phase 2（将来）**: クライアント側の分割（SettingsPanel 等）は別途検討

---

## 2. 現状分析

### 2.1 server/index.js の構成（おおよその行数）

| 範囲（行） | 内容 |
|-----------|------|
| 1–250 | 初期化・定数・ディレクトリ確保・DB スキーマ・multer 設定 |
| 250–450 | 画像準備・API 送信用変換 |
| 355–640 | 画像生成（Gemini / OpenAI）・プロンプト構築 |
| 642–910 | **Inpaint 関連**（マスク bbox、パッチ、ブレンド、プロンプト解析） |
| 886–975 | テキストオーバーレイ（セリフ描画、フォント設定） |
| 977–1180 | DB helpers・設定取得・キャラクター取得・画風関連 |
| 1179–1420 | 画風設定 JSON パース・選択ロジック・正規化 |
| 1420–2085 | Comics API ルート（取得・更新・パネル操作）＋Inpaint API 実装 |
| 2085–2178 | Characters API |
| 2178–2323 | Settings API |
| 2323–2921 | Comics API（続き）・構成提案 API |
| 2921–4041 | Comic Generation API（一括生成・Inpaint ルート・Undo 等） |
| 4041–4310 | Export API・サーバー起動 |

### 2.2 主要な依存関係

- **Inpaint**: `getSetting`, `getConceptConfig`, `getSerifFontConfig`, `getStyleRefImageParts`, `prepareRefImageForApi`, `getImageProvider`, `run`, `get`, `all` 等
- **画像生成**: `getSetting`, `getConceptConfig`, 画風設定関数群, `run`, `get`, `all`, `path`, `sharp`, `fs`
- **API ルート**: 上記すべて＋`db`, `app`, `multer` インスタンス

---

## 3. 目標ディレクトリ構成

```
server/
├── index.js                 # 起動・Express 設定・ルート登録（簡潔に保つ）
├── package.json
├── lib/
│   ├── db.js                # DB 接続・run/get/all
│   ├── config.js            # getSetting, setSetting, ディレクトリ定数
│   ├── paths.js             # getGeneratedDirForDate, getGeneratedPathForDate
│   └── multer.js            # upload, characterUpload, comicRefUpload, styleRefUpload
├── services/
│   ├── imageGeneration.js   # 画像生成（Gemini/OpenAI）・プロンプト構築・結合
│   ├── inpaint.js           # Inpaint 本体（マスク・パッチ・ブレンド・セリフオーバーレイ）
│   ├── imageStyle.js        # 画風設定 JSON パース・選択・フォーマット
│   └── concept.js           # getConceptConfig, getConceptContext
├── routes/
│   ├── characters.js        # /api/characters
│   ├── settings.js          # /api/settings/*
│   ├── comics.js            # /api/comics/*（取得・更新・パネル・構成提案）
│   ├── comicGeneration.js   # /api/comics/:date/generate, Inpaint, Undo
│   └── export.js            # /api/comics/:date/export
└── middleware/
    └── (将来的に必要なら追加)
```

### 3.1 各モジュールの責任

| モジュール | 主な責務 |
|-----------|----------|
| `index.js` | Express 初期化、ミドルウェア、静的ファイル、ルート読み込み、`app.listen` |
| `lib/db.js` | `db` インスタンス、`run`, `get`, `all` |
| `lib/config.js` | `getSetting`, `setSetting`, `ROOT_DIR`, `DB_DIR`, `UPLOADS_DIR`, `GENERATED_DIR`, `PANEL_SIZE` 等 |
| `lib/paths.js` | `getGeneratedDirForDate`, `getGeneratedPathForDate` |
| `lib/multer.js` | 各種 Multer インスタンス |
| `services/imageGeneration.js` | `getImageProvider`, `generatePanelImage`, `buildCombinedPanelImagePrompt`, `generateCombinedPanelImage` 等 |
| `services/inpaint.js` | `getMaskBoundingBox`, `blendInpaintPatchWithMask`, `binarizeMaskPatch`, `renderSerifOverlayToBuffer`, `expandIllustrationPrompt` 等 |
| `services/imageStyle.js` | `parseImageStyleConfig`, `getSelectedImageStyleObject`, `formatImageStylePrompt`, `hasImageStyleConfigSelected` 等 |
| `services/concept.js` | `getConceptConfig`, `getConceptContext` |
| `routes/*` | 各 API のハンドラ。必要に応じて `services/*` と `lib/*` を import |

---

## 4. モジュール間の依存関係

```
index.js
  └── routes/* (app にルート登録)

routes/comics.js, comicGeneration.js, ...
  └── lib/db, lib/config, lib/paths, lib/multer
  └── services/imageGeneration, inpaint, imageStyle, concept

services/imageGeneration.js
  └── lib/db, lib/config, lib/paths
  └── services/imageStyle, concept

services/inpaint.js
  └── lib/config
  └── services/concept（expandIllustrationPrompt 用）

services/imageStyle.js
  └── lib/config

services/concept.js
  └── lib/db (getSetting 経由)
```

- **循環参照を避ける**: `lib/config.js` は `lib/db.js` を import し、`getSetting` / `setSetting` で DB にアクセスする形とする

---

## 5. 移行順序（推奨）

各ステップ後、サーバー起動・主要 API の動作確認を行う。

| ステップ | 内容 | リスク |
|---------|------|--------|
| 1 | `lib/db.js` 作成。`run`, `get`, `all` を切り出し、index.js から import | 低 |
| 2 | `lib/config.js`, `lib/paths.js` 作成。定数・getSetting/setSetting・パス関数を切り出し | 低 |
| 3 | `lib/multer.js` 作成。各種 multer インスタンスを切り出し | 低 |
| 4 | `services/concept.js` 作成 | 低 |
| 5 | `services/imageStyle.js` 作成 | 中（画風関連の参照が多い） |
| 6 | `services/imageGeneration.js` 作成 | 中 |
| 7 | `services/inpaint.js` 作成 | 高（多くの依存・複雑な呼び出し） |
| 8 | `routes/characters.js` 作成 | 低 |
| 9 | `routes/settings.js` 作成 | 低 |
| 10 | `routes/comics.js` 作成 | 中 |
| 11 | `routes/comicGeneration.js` 作成 | 高 |
| 12 | `routes/export.js` 作成 | 低 |
| 13 | `index.js` をルート登録のみに整理 | 中 |

---

## 6. ロールバック方針

- 各ステップを **1 コミット** で行い、問題があればそのコミットを revert
- 大きなステップ（例: 7, 11）の前に `git tag refactor-step-N` を打っておく
- リファクタ専用ブランチ（例: `refactor/server-split`）で作業し、main へのマージ前に全体テスト

---

## 7. 未使用コードの整理

リファクタとは別タスクとするが、以下の整理を推奨：

- `client/src/_archive/` 内の `ImagePreview.jsx`, `PostEditor.jsx`: 参照がなければ削除候補
- `docs/archive/` 内ドキュメント: 参照がなければ保持のまま（アーカイブ用途）

リファクタ完了後に実施することを推奨。

---

## 8. Phase 2（クライアント）の将来検討

- `SettingsPanel.jsx`（約 750 行）: タブ単位やセクション単位での分割を検討
- `PrepareTab.jsx`, `PanelEditor.jsx`: 行数が増えた場合に同様の分割を検討
- 本設計書の範囲外とする

---

## 9. チェックリスト（実装時）

- [ ] 各モジュールで `import`/`export` が正しく設定されているか
- [ ] `ROOT_DIR` 等のパスが正しく解決されるか
- [ ] DB の `run`/`get`/`all` が全ルートで利用可能か
- [ ] Inpaint API が従来どおり動作するか（セリフ・イラスト両モード）
- [ ] 画像生成（一括・個別）が従来どおり動作するか
- [ ] Export API が従来どおり動作するか
- [ ] 既存の環境変数・設定の読み込みに問題がないか
