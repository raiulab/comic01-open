# 4コマまんが制作アプリ 設計書

## 概要

既存のX自動投稿アプリを「4コマまんが制作アプリ」にカスタマイズする。
毎日投稿する4コマ漫画の制作を支援するツール。

## 主要機能

### 0. 初期設定
- 基本設定: 画風（テキスト）、コマ数（デフォルト4）
- キャラクター設定: 名前 + 画像（1キャラ1枚、最大21キャラ）

### 1. 生成準備
- テーマと概要を手書き入力
- 「提案」ボタンでAIがテーマ・概要を生成
- 登録キャラクターから選択して参照に使用
- 追加参照画像のアップロード（背景・小物用、その日限り）

### 2. 生成
- 「まんが生成」ボタンで全コマ一括生成
- スタイル: 白背景、黒マジックペンのラフなイラスト漫画

### 3. 調整
- コマ単位でプレビュー表示
- 1コマ単位で再生成（テキスト指示）
- 1コマ単位でInpaint（マスク領域 + テキスト指示）

### 4. 出力
- 結合画像のプレビュー
- ダウンロード機能
- 保存時に出力フォルダへ日時ファイル名で自動保存

---

## データベース設計

### settings テーブル（既存拡張）

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

使用するキー:
- `drawing_style`: 画風テキスト
- `panel_count`: コマ数（デフォルト4）

### characters テーブル（新規）

```sql
CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  image_path TEXT,
  description TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

最大21件まで登録可能。

### comics テーブル（新規、postsを置き換え）

```sql
CREATE TABLE IF NOT EXISTS comics (
  date TEXT PRIMARY KEY,
  theme TEXT,
  summary TEXT,
  status TEXT DEFAULT 'draft',
  ref_images TEXT,
  selected_characters TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

ステータス: `draft` → `generating` → `completed`

### panels テーブル（新規）

```sql
CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comic_date TEXT NOT NULL,
  panel_number INTEGER NOT NULL,
  image_path TEXT,
  status TEXT DEFAULT 'ungenerated',
  UNIQUE(comic_date, panel_number),
  FOREIGN KEY (comic_date) REFERENCES comics(date)
);
```

ステータス: `ungenerated` → `generated` → `approved`

---

## API設計

### 設定系

| Method | Endpoint | 説明 |
|--------|----------|------|
| GET | `/api/settings` | 基本設定取得 |
| POST | `/api/settings` | 基本設定保存 |
| GET | `/api/characters` | キャラクター一覧 |
| POST | `/api/characters` | キャラクター追加 |
| DELETE | `/api/characters/:id` | キャラクター削除 |

### 漫画系

| Method | Endpoint | 説明 |
|--------|----------|------|
| GET | `/api/comics` | 漫画一覧 |
| GET | `/api/comics/:date` | 漫画詳細（コマ含む） |
| POST | `/api/comics/:date` | 漫画作成・更新 |
| POST | `/api/comics/:date/suggest` | テーマ・概要のAI提案 |

### 生成系

| Method | Endpoint | 説明 |
|--------|----------|------|
| POST | `/api/comics/:date/generate` | 全コマ一括生成 |
| POST | `/api/comics/:date/panels/:num/regenerate` | 1コマ再生成 |
| POST | `/api/comics/:date/panels/:num/inpaint` | 1コマInpaint |
| POST | `/api/comics/:date/panels/:num/status` | コマステータス更新 |

### 出力系

| Method | Endpoint | 説明 |
|--------|----------|------|
| GET | `/api/comics/:date/export` | 結合画像生成 |
| POST | `/api/comics/:date/save` | 出力フォルダへ保存 |

---

## UI構成

### レイアウト

```
┌─────────────────────────────────────────────────────────┐
│ ヘッダー: 4コマまんが制作アプリ     [設定ボタン]        │
├────────────┬────────────────────────────────────────────┤
│            │                                            │
│ カレンダー │  メインエリア（タブ切り替え）              │
│            │  ┌─────┬─────┬─────┬─────┐                │
│ (日付選択) │  │準備 │生成 │調整 │出力 │                │
│            │  └─────┴─────┴─────┴─────┘                │
│            │                                            │
│            │  [タブに応じたコンテンツ]                  │
│            │                                            │
├────────────┴────────────────────────────────────────────┤
│ ステータスバー: 全体進捗 + コマ単位進捗表示             │
└─────────────────────────────────────────────────────────┘
```

### コンポーネント

| ファイル | 説明 |
|----------|------|
| `App.jsx` | 全体レイアウト、タブ管理 |
| `CalendarView.jsx` | カレンダー（既存改修） |
| `SettingsPanel.jsx` | 基本設定 + キャラクター管理 |
| `PrepareTab.jsx` | 準備タブ（新規） |
| `GenerateTab.jsx` | 生成タブ（新規） |
| `AdjustTab.jsx` | 調整タブ（新規） |
| `OutputTab.jsx` | 出力タブ（新規） |
| `PanelEditor.jsx` | コマ編集UI + Inpaint（新規） |

---

## 画像生成

### プロンプト構成

```
[システム指示]
・白背景、黒のマジックペンで描かれたラフなイラスト漫画スタイル
・{panel_count}コマ漫画の{n}コマ目

[画風設定]
・ユーザー設定の画風テキスト

[キャラクター情報]
・選択キャラクターの名前と説明
・参照画像を添付

[コンテンツ指示]
・テーマ: {theme}
・概要: {summary}
・このコマの内容: {n}コマ目の展開

[追加参照]
・背景・小物の参照画像（あれば）
```

### 生成フロー

1. 「まんが生成」ボタン押下
2. AIがテーマ・概要から各コマの内容を分割
3. 各コマを順次生成（プログレス表示）
4. 全体ステータスを `completed` に更新

### Inpaint処理

1. キャンバス上でマスク領域を塗る
2. マスク画像 + 元画像 + テキスト指示を送信
3. Geminiで部分再生成

---

## 実装順序

1. DBスキーマ変更 + 基本API（settings, characters, comics CRUD）
2. 設定画面（キャラクター管理UI）
3. 準備タブ（テーマ・概要入力、キャラ選択、参照画像）
4. 生成タブ + 画像生成API
5. 調整タブ（コマ表示、再生成）
6. Inpaint機能
7. 出力タブ（結合・ダウンロード）

---

## 技術スタック（変更なし）

- フロントエンド: React 18 + Vite + Tailwind CSS
- バックエンド: Node.js + Express + SQLite3
- AI: Google Generative AI (Gemini)
