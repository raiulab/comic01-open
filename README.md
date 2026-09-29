# Comic01 Open

## 日本語

4コマ漫画の構成、生成、編集、書き出しを一つの流れで扱う、ローカル優先の制作ツールです。

公開版にはアプリケーションコードと中立的なサンプル設定だけを収録しています。キャラクター画像、非公開の作品設定、生成画像、データベース、生成履歴は意図的に含めていません。

### 機能

- カレンダーによるエピソード管理
- シリーズ設定と画風設定
- キャラクター参照画像の登録
- 4コマ構成案の生成
- GeminiまたはOpenAIによる画像生成
- コマ単位の再生成とマスク指定Inpaint
- 追加生成を使わないセリフ文字オーバーレイ
- 縦並びまたは2×2レイアウトでの画像書き出し

### 技術構成

- React 18、Vite、Tailwind CSS
- Node.js、Express
- SQLite
- Sharp、node-canvas
- Google Geminiおよび任意のOpenAI画像API

### クイックスタート

Node.js 22以上、npm、お使いの環境で`canvas`が必要とするネイティブ依存関係を用意してください。

```bash
npm install
cp .env.example .env
# .envに少なくともGOOGLE_API_KEYを設定
npm run dev:server
```

別のターミナルで次を実行します。

```bash
npm run dev
```

<http://localhost:5173>を開きます。APIサーバーの既定ポートは`8000`です。

### 検証

```bash
npm test
npm run build
```

テストでは、プロンプト正規化、構成テンプレート、セリフ抽出を確認します。テスト中に外部APIは呼び出しません。

### 設定

- `config/series-concept.json`：中立的なサンプルシリーズ設定
- `config/image-style.json`：選択可能な画風プロンプト
- `config/serif-font.json`：セリフ描画に使う任意のローカルフォントパス

実行時のコンテンツは、Git管理外の次のディレクトリに保存されます。

- `db/`
- `uploads/`
- `generated/`
- `output/`

非公開キャラクター、未公開の作品設定、API応答、生成メディアをコミットしないでください。

### 環境変数

| 変数 | 用途 |
| --- | --- |
| `GOOGLE_API_KEY` | Geminiによる生成・提案 |
| `OPENAI_API_KEY` | 任意のOpenAI画像プロバイダー |
| `PERPLEXITY_API_KEY` | 任意の提案プロバイダー |
| `IMAGE_PROVIDER` | `gemini`または`openai` |
| `IMAGE_MODEL` | プロバイダー固有の画像モデル |
| `PORT` | APIポート。既定値は`8000` |

生成リクエストには料金が発生する場合があります。実行前に、選択したプロバイダーの最新料金と利用条件を確認してください。

### リポジトリ方針

このリポジトリは再利用可能なアプリケーションエンジンであり、コンテンツ保管庫ではありません。同梱設定はローカル評価用の架空かつ中立的なサンプルです。利用者自身が権利を持つキャラクターや作品設定は、Git管理外の実行時ストレージから追加してください。

### ライセンス

コードはMIT Licenseで提供します。第三者パッケージ、フォント、モデル、生成コンテンツには、それぞれのライセンスとサービス利用条件が適用されます。非公開のキャラクターや作品IPは、このリポジトリのライセンス対象ではありません。

---

## English

A local-first workflow for planning, generating, editing, and exporting four-panel comics.

The public edition contains only application code and neutral example settings. Character art,
private story bibles, generated images, databases, and generation history are intentionally kept
outside the repository.

## Features

- Calendar-based episode management
- Configurable series concept and visual style
- Character reference registration
- Four-panel structure suggestions
- Gemini or OpenAI image generation
- Panel regeneration and masked inpainting
- Speech-text overlay fallback without another generation request
- Vertical or 2x2 image export

## Stack

- React 18, Vite, and Tailwind CSS
- Node.js and Express
- SQLite
- Sharp and node-canvas
- Google Gemini and optional OpenAI image APIs

## Quick start

Requirements: Node.js 22 or later, npm, and the native prerequisites required by
`canvas` on your platform.

```bash
npm install
cp .env.example .env
# Add at least GOOGLE_API_KEY to .env
npm run dev:server
```

In a second terminal:

```bash
npm run dev
```

Open <http://localhost:5173>. The API server listens on port `8000` by default.

## Checks

```bash
npm test
npm run build
```

Tests cover prompt normalization, structure templates, and speech extraction. API calls are not
performed by the test suite.

## Configuration

- `config/series-concept.json`: neutral sample series settings
- `config/image-style.json`: selectable visual-style prompts
- `config/serif-font.json`: optional local font path for speech overlays

Runtime content is stored in ignored directories:

- `db/`
- `uploads/`
- `generated/`
- `output/`

Do not commit private characters, unpublished story settings, API responses, or generated media.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `GOOGLE_API_KEY` | Gemini generation and suggestions |
| `OPENAI_API_KEY` | Optional OpenAI image provider |
| `PERPLEXITY_API_KEY` | Optional suggestion provider |
| `IMAGE_PROVIDER` | `gemini` or `openai` |
| `IMAGE_MODEL` | Provider-specific image model |
| `PORT` | API port; defaults to `8000` |

Provider usage may incur charges. Review the selected provider's current pricing and terms before
running generation requests.

## Repository policy

This repository is the reusable application engine, not a content archive. The included concept
is a fictional neutral fixture for local evaluation. Bring your own characters and story settings
through ignored runtime storage.

## License

Code is licensed under the MIT License. Third-party packages, fonts, models, and generated content
remain subject to their respective licenses and service terms. No private character or story IP is
licensed by this repository.
