# 4コマまんが制作アプリ 実装計画

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** X自動投稿アプリを4コマまんが制作アプリにカスタマイズする

**Architecture:** SQLiteでキャラクター・漫画・コマを管理、React+タブUIで工程を分離、Gemini APIで画像生成

**Tech Stack:** React 18, Vite, Tailwind CSS, Express, SQLite3, Google Generative AI, Sharp

---

## Task 1: データベーススキーマ変更

**Files:**
- Modify: `server/index.js:35-58`

**Step 1: DBスキーマを更新**

`server/index.js` の `db.serialize()` ブロックを以下に置き換え:

```javascript
db.serialize(() => {
  // 設定テーブル（既存）
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // キャラクターテーブル（新規）
  db.run(`
    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      image_path TEXT,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 漫画テーブル（新規、postsを置き換え）
  db.run(`
    CREATE TABLE IF NOT EXISTS comics (
      date TEXT PRIMARY KEY,
      theme TEXT,
      summary TEXT,
      status TEXT DEFAULT 'draft',
      ref_images TEXT,
      selected_characters TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // コマテーブル（新規）
  db.run(`
    CREATE TABLE IF NOT EXISTS panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      comic_date TEXT NOT NULL,
      panel_number INTEGER NOT NULL,
      image_path TEXT,
      status TEXT DEFAULT 'ungenerated',
      UNIQUE(comic_date, panel_number)
    )
  `);

  // 後方互換: postsテーブルは残す（必要に応じて削除可）
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      date TEXT PRIMARY KEY,
      topic TEXT,
      generation_mode TEXT DEFAULT 'character',
      tweet_text TEXT,
      image_prompt TEXT,
      image_path TEXT,
      status TEXT
    )
  `);

  // デフォルト設定の初期化
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('panel_count', '4')`);
  db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('drawing_style', '')`);
});
```

**Step 2: サーバー再起動して確認**

Run: `cd /Library/WebServer/Documents/html/raiu/comic01 && npm run dev:server`
Expected: サーバーが起動し、DBにテーブルが作成される

**Step 3: コミット**

```bash
git add server/index.js
git commit -m "feat: add database schema for comics, panels, characters"
```

---

## Task 2: キャラクターAPI実装

**Files:**
- Modify: `server/index.js`

**Step 1: キャラクター用Multer設定を追加**

`server/index.js` のMulter設定の後（84行目付近）に追加:

```javascript
// キャラクター画像用Multer
const characterStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const charDir = path.join(UPLOADS_DIR, 'characters');
    if (!fs.existsSync(charDir)) {
      fs.mkdirSync(charDir, { recursive: true });
    }
    cb(null, charDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const timestamp = Date.now();
    cb(null, `char_${timestamp}${ext}`);
  }
});
const characterUpload = multer({
  storage: characterStorage,
  limits: { fileSize: 10 * 1024 * 1024 }
});
```

**Step 2: キャラクターCRUD APIを追加**

`server/index.js` のRoutes セクション（204行目付近）に追加:

```javascript
// === Characters API ===
const MAX_CHARACTERS = 21;

// キャラクター一覧取得
app.get('/api/characters', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM characters ORDER BY created_at');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'キャラクター一覧の取得に失敗しました。' });
  }
});

// キャラクター追加
app.post('/api/characters', characterUpload.single('image'), async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'キャラクター名は必須です。' });
    }

    const count = await get('SELECT COUNT(*) as cnt FROM characters');
    if (count.cnt >= MAX_CHARACTERS) {
      return res.status(400).json({ error: `キャラクターは最大${MAX_CHARACTERS}件までです。` });
    }

    const imagePath = req.file ? path.basename(req.file.path) : null;

    const result = await run(
      'INSERT INTO characters (name, image_path, description) VALUES (?, ?, ?)',
      [name.trim(), imagePath, description || '']
    );

    const newChar = await get('SELECT * FROM characters WHERE id = ?', [result.lastID]);
    res.json(newChar);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'キャラクターの追加に失敗しました。' });
  }
});

// キャラクター削除
app.delete('/api/characters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const char = await get('SELECT * FROM characters WHERE id = ?', [id]);
    if (!char) {
      return res.status(404).json({ error: 'キャラクターが見つかりません。' });
    }

    // 画像ファイルも削除
    if (char.image_path) {
      const imgPath = path.join(UPLOADS_DIR, 'characters', char.image_path);
      if (fs.existsSync(imgPath)) {
        fs.unlinkSync(imgPath);
      }
    }

    await run('DELETE FROM characters WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'キャラクターの削除に失敗しました。' });
  }
});
```

**Step 3: キャラクター画像の静的配信を追加**

`server/index.js` の静的ファイル配信（65-66行目付近）に追加:

```javascript
app.use('/uploads/characters', express.static(path.join(UPLOADS_DIR, 'characters')));
```

**Step 4: コミット**

```bash
git add server/index.js
git commit -m "feat: add characters CRUD API"
```

---

## Task 3: 基本設定API実装

**Files:**
- Modify: `server/index.js`

**Step 1: 基本設定取得・保存APIを追加**

```javascript
// === Settings API ===

// 基本設定取得
app.get('/api/settings', async (req, res) => {
  try {
    const panelCount = (await getSetting('panel_count')) || '4';
    const drawingStyle = (await getSetting('drawing_style')) || '';
    res.json({
      panel_count: parseInt(panelCount, 10),
      drawing_style: drawingStyle
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '設定の取得に失敗しました。' });
  }
});

// 基本設定保存
app.post('/api/settings', async (req, res) => {
  try {
    const { panel_count, drawing_style } = req.body;
    if (panel_count !== undefined) {
      const count = Math.max(1, Math.min(10, parseInt(panel_count, 10) || 4));
      await setSetting('panel_count', String(count));
    }
    if (drawing_style !== undefined) {
      await setSetting('drawing_style', drawing_style);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '設定の保存に失敗しました。' });
  }
});
```

**Step 2: コミット**

```bash
git add server/index.js
git commit -m "feat: add basic settings API"
```

---

## Task 4: 漫画CRUD API実装

**Files:**
- Modify: `server/index.js`

**Step 1: 漫画用の追加参照画像Multer設定**

```javascript
// 漫画の追加参照画像用Multer
const comicRefStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const refDir = path.join(UPLOADS_DIR, 'comic_refs');
    if (!fs.existsSync(refDir)) {
      fs.mkdirSync(refDir, { recursive: true });
    }
    cb(null, refDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    const timestamp = Date.now();
    const index = req.files ? req.files.length : 0;
    cb(null, `ref_${timestamp}_${index}${ext}`);
  }
});
const comicRefUpload = multer({
  storage: comicRefStorage,
  limits: { fileSize: 10 * 1024 * 1024 }
});
```

**Step 2: 漫画CRUD APIを追加**

```javascript
// === Comics API ===

// 漫画一覧取得
app.get('/api/comics', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM comics ORDER BY date DESC');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '漫画一覧の取得に失敗しました。' });
  }
});

// 漫画詳細取得（コマ情報含む）
app.get('/api/comics/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic) {
      return res.json({ date, status: 'draft', theme: '', summary: '' });
    }
    const panels = await all(
      'SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number',
      [date]
    );
    res.json({ ...comic, panels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '漫画の取得に失敗しました。' });
  }
});

// 漫画作成・更新
app.post('/api/comics/:date', comicRefUpload.array('ref_images', 10), async (req, res) => {
  try {
    const { date } = req.params;
    const { theme, summary, selected_characters, status } = req.body;

    let existingComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    let refImages = existingComic?.ref_images || '';

    // 新規参照画像がアップロードされた場合
    if (req.files && req.files.length > 0) {
      const newRefs = req.files.map(f => path.basename(f.path));
      const existing = refImages ? refImages.split(',').filter(Boolean) : [];
      refImages = [...existing, ...newRefs].join(',');
    }

    await run(`
      INSERT INTO comics (date, theme, summary, status, ref_images, selected_characters)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        theme = COALESCE(excluded.theme, comics.theme),
        summary = COALESCE(excluded.summary, comics.summary),
        status = COALESCE(excluded.status, comics.status),
        ref_images = excluded.ref_images,
        selected_characters = COALESCE(excluded.selected_characters, comics.selected_characters)
    `, [
      date,
      theme || existingComic?.theme || '',
      summary || existingComic?.summary || '',
      status || existingComic?.status || 'draft',
      refImages,
      selected_characters || existingComic?.selected_characters || ''
    ]);

    const updated = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const panels = await all(
      'SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number',
      [date]
    );
    res.json({ ...updated, panels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '漫画の保存に失敗しました。' });
  }
});

// 追加参照画像の削除
app.delete('/api/comics/:date/ref/:filename', async (req, res) => {
  try {
    const { date, filename } = req.params;
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic) {
      return res.status(404).json({ error: '漫画が見つかりません。' });
    }

    const refs = comic.ref_images ? comic.ref_images.split(',').filter(Boolean) : [];
    const filtered = refs.filter(f => f !== filename);
    await run('UPDATE comics SET ref_images = ? WHERE date = ?', [filtered.join(','), date]);

    const filePath = path.join(UPLOADS_DIR, 'comic_refs', filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ ok: true, ref_images: filtered });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '参照画像の削除に失敗しました。' });
  }
});

// 静的配信
app.use('/uploads/comic_refs', express.static(path.join(UPLOADS_DIR, 'comic_refs')));
```

**Step 3: コミット**

```bash
git add server/index.js
git commit -m "feat: add comics CRUD API"
```

---

## Task 5: テーマ・概要AI提案API

**Files:**
- Modify: `server/index.js`

**Step 1: AI提案APIを追加**

```javascript
// テーマ・概要のAI提案
app.post('/api/comics/:date/suggest', async (req, res) => {
  try {
    const { date } = req.params;
    const model = getTextModel();
    const drawingStyle = (await getSetting('drawing_style')) || '';
    const panelCount = (await getSetting('panel_count')) || '4';

    const dt = new Date(date);
    const year = dt.getFullYear();
    const month = dt.getMonth() + 1;
    const day = dt.getDate();

    const styleContext = drawingStyle
      ? `\n画風設定: ${drawingStyle}`
      : '';

    const prompt = `
あなたは4コマ漫画のテーマと概要を提案するAIです。
指定された日付に合った、面白い4コマ漫画のアイデアを提案してください。

要件:
- 日本の祝日、季節イベント、流行を意識すること
- ${panelCount}コマ漫画として成立するストーリー
- 起承転結のある展開${styleContext}

出力は JSON のみとし、以下の形式にしてください:
{
  "theme": "テーマ（一言）",
  "summary": "概要（${panelCount}コマの流れを含む、2〜3文）"
}

対象日: ${year}年${month}月${day}日
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.status(500).json({ error: 'AI提案の取得に失敗しました。' });
    }

    const suggestion = JSON.parse(jsonMatch[0]);
    res.json(suggestion);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'テーマ提案に失敗しました。' });
  }
});
```

**Step 2: コミット**

```bash
git add server/index.js
git commit -m "feat: add AI theme/summary suggestion API"
```

---

## Task 6: App.jsx タブUI化

**Files:**
- Modify: `client/src/App.jsx`

**Step 1: App.jsxを書き換え**

```jsx
import React, { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';
import CalendarView from './components/CalendarView';
import SettingsPanel from './components/SettingsPanel';
import PrepareTab from './components/PrepareTab';
import GenerateTab from './components/GenerateTab';
import AdjustTab from './components/AdjustTab';
import OutputTab from './components/OutputTab';
import api from './api';

const TABS = [
  { id: 'prepare', label: '準備' },
  { id: 'generate', label: '生成' },
  { id: 'adjust', label: '調整' },
  { id: 'output', label: '出力' },
];

const App = () => {
  const [comics, setComics] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [currentComic, setCurrentComic] = useState(null);
  const [activeTab, setActiveTab] = useState('prepare');
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    fetchComics();
  }, []);

  const fetchComics = async () => {
    try {
      const res = await api.get('/comics');
      setComics(Array.isArray(res.data) ? res.data : []);
    } catch (e) {
      console.error(e);
      setComics([]);
    }
  };

  const handleDateSelect = async (dateStr) => {
    setSelectedDate(dateStr);
    try {
      const res = await api.get(`/comics/${dateStr}`);
      setCurrentComic(res.data);
    } catch (e) {
      console.error(e);
      setCurrentComic({ date: dateStr, status: 'draft' });
    }
  };

  const handleComicUpdate = (updated) => {
    setCurrentComic(updated);
    setComics((prev) => {
      const others = prev.filter((c) => c.date !== updated.date);
      return [...others, updated];
    });
  };

  const renderTabContent = () => {
    if (!selectedDate) {
      return (
        <div className="text-center text-slate-400 py-12">
          カレンダーから日付を選択してください
        </div>
      );
    }

    switch (activeTab) {
      case 'prepare':
        return (
          <PrepareTab
            date={selectedDate}
            comic={currentComic}
            onComicUpdate={handleComicUpdate}
          />
        );
      case 'generate':
        return (
          <GenerateTab
            date={selectedDate}
            comic={currentComic}
            onComicUpdate={handleComicUpdate}
          />
        );
      case 'adjust':
        return (
          <AdjustTab
            date={selectedDate}
            comic={currentComic}
            onComicUpdate={handleComicUpdate}
          />
        );
      case 'output':
        return (
          <OutputTab
            date={selectedDate}
            comic={currentComic}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">4コマまんが制作アプリ</h1>
            <p className="text-xs text-slate-400 mt-1">
              毎日投稿する4コマ漫画の制作を支援
            </p>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-800 px-3 py-1 text-xs hover:bg-slate-700"
          >
            <Settings size={14} />
            <span>設定</span>
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-4 grid grid-cols-1 lg:grid-cols-4 gap-4">
        <section className="lg:col-span-1">
          <CalendarView comics={comics} onDateSelect={handleDateSelect} />
        </section>
        <section className="lg:col-span-3">
          {/* タブナビゲーション */}
          <div className="flex border-b border-slate-800 mb-4">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'border-b-2 border-emerald-500 text-emerald-400'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* タブコンテンツ */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            {renderTabContent()}
          </div>

          {/* ステータスバー */}
          {currentComic && (
            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-2 text-xs text-slate-400">
              <span>ステータス: </span>
              <span className={`font-medium ${
                currentComic.status === 'completed' ? 'text-emerald-400' :
                currentComic.status === 'generating' ? 'text-amber-400' :
                'text-slate-300'
              }`}>
                {currentComic.status === 'completed' ? '完成' :
                 currentComic.status === 'generating' ? '生成中' : '下書き'}
              </span>
              {currentComic.panels && (
                <span className="ml-4">
                  コマ: {currentComic.panels.filter(p => p.status !== 'ungenerated').length} / {currentComic.panels.length} 生成済み
                </span>
              )}
            </div>
          )}
        </section>
      </main>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
};

export default App;
```

**Step 2: コミット**

```bash
git add client/src/App.jsx
git commit -m "feat: convert App to tab-based UI for comic workflow"
```

---

## Task 7: CalendarView更新

**Files:**
- Modify: `client/src/components/CalendarView.jsx`

**Step 1: CalendarViewを漫画用に更新**

```jsx
import React, { useState } from 'react';
import Calendar from 'react-calendar';
import 'react-calendar/dist/Calendar.css';

const formatDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const CalendarView = ({ comics, onDateSelect }) => {
  const [value, setValue] = useState(new Date());

  const handleChange = (d) => {
    setValue(d);
    onDateSelect(formatDate(d));
  };

  const getTileClass = ({ date, view }) => {
    if (view !== 'month') return '';
    const dateStr = formatDate(date);
    const comic = comics.find((c) => c.date === dateStr);
    if (!comic) return '';
    if (comic.status === 'completed') return 'bg-emerald-600 text-white rounded-full';
    if (comic.status === 'generating') return 'bg-amber-500 text-white rounded-full';
    if (comic.status === 'draft' && (comic.theme || comic.summary)) return 'bg-sky-600 text-white rounded-full';
    return '';
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 shadow-lg">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold">カレンダー</h2>
      </div>
      <Calendar
        locale="ja-JP"
        onChange={handleChange}
        value={value}
        tileClassName={getTileClass}
        className="w-full bg-slate-900 text-slate-100 border-0 rounded-lg [&_.react-calendar__tile]:py-1"
      />
      <div className="mt-3 text-[10px] text-slate-400 space-y-1">
        <p>● ブルー: テーマ設定済み</p>
        <p>● オレンジ: 生成中</p>
        <p>● グリーン: 完成</p>
      </div>
    </div>
  );
};

export default CalendarView;
```

**Step 2: コミット**

```bash
git add client/src/components/CalendarView.jsx
git commit -m "feat: update CalendarView for comic status display"
```

---

## Task 8: SettingsPanel拡張（キャラクター管理）

**Files:**
- Modify: `client/src/components/SettingsPanel.jsx`

**Step 1: SettingsPanelを書き換え**

```jsx
import React, { useEffect, useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import api from '../api';

const MAX_CHARACTERS = 21;

const SettingsPanel = ({ onClose }) => {
  const [activeSection, setActiveSection] = useState('basic');
  const [panelCount, setPanelCount] = useState(4);
  const [drawingStyle, setDrawingStyle] = useState('');
  const [characters, setCharacters] = useState([]);
  const [newCharName, setNewCharName] = useState('');
  const [newCharDesc, setNewCharDesc] = useState('');
  const [newCharImage, setNewCharImage] = useState(null);
  const [newCharPreview, setNewCharPreview] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAddingChar, setIsAddingChar] = useState(false);

  useEffect(() => {
    loadSettings();
    loadCharacters();
  }, []);

  useEffect(() => {
    if (newCharImage) {
      const url = URL.createObjectURL(newCharImage);
      setNewCharPreview(url);
      return () => URL.revokeObjectURL(url);
    }
    setNewCharPreview(null);
  }, [newCharImage]);

  const loadSettings = async () => {
    try {
      const res = await api.get('/settings');
      setPanelCount(res.data.panel_count || 4);
      setDrawingStyle(res.data.drawing_style || '');
    } catch (e) {
      console.error(e);
    }
  };

  const loadCharacters = async () => {
    try {
      const res = await api.get('/characters');
      setCharacters(res.data || []);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveSettings = async () => {
    setIsSaving(true);
    try {
      await api.post('/settings', { panel_count: panelCount, drawing_style: drawingStyle });
      alert('設定を保存しました。');
    } catch (e) {
      console.error(e);
      alert('設定の保存に失敗しました。');
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddCharacter = async () => {
    if (!newCharName.trim()) {
      alert('キャラクター名を入力してください。');
      return;
    }
    if (characters.length >= MAX_CHARACTERS) {
      alert(`キャラクターは最大${MAX_CHARACTERS}件までです。`);
      return;
    }
    setIsAddingChar(true);
    try {
      const formData = new FormData();
      formData.append('name', newCharName.trim());
      formData.append('description', newCharDesc);
      if (newCharImage) {
        formData.append('image', newCharImage);
      }
      const res = await api.post('/characters', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setCharacters([...characters, res.data]);
      setNewCharName('');
      setNewCharDesc('');
      setNewCharImage(null);
    } catch (e) {
      console.error(e);
      alert(e.response?.data?.error || 'キャラクターの追加に失敗しました。');
    } finally {
      setIsAddingChar(false);
    }
  };

  const handleDeleteCharacter = async (id) => {
    if (!confirm('このキャラクターを削除しますか？')) return;
    try {
      await api.delete(`/characters/${id}`);
      setCharacters(characters.filter(c => c.id !== id));
    } catch (e) {
      console.error(e);
      alert('削除に失敗しました。');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="w-full max-w-2xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-slate-700">
          <h2 className="text-sm font-semibold">設定</h2>
          <button onClick={onClose} className="text-xs text-slate-400 hover:text-slate-100">
            閉じる
          </button>
        </div>

        {/* セクション切り替え */}
        <div className="flex border-b border-slate-700">
          <button
            onClick={() => setActiveSection('basic')}
            className={`px-4 py-2 text-xs font-medium ${
              activeSection === 'basic' ? 'border-b-2 border-emerald-500 text-emerald-400' : 'text-slate-400'
            }`}
          >
            基本設定
          </button>
          <button
            onClick={() => setActiveSection('characters')}
            className={`px-4 py-2 text-xs font-medium ${
              activeSection === 'characters' ? 'border-b-2 border-emerald-500 text-emerald-400' : 'text-slate-400'
            }`}
          >
            キャラクター ({characters.length}/{MAX_CHARACTERS})
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {activeSection === 'basic' && (
            <div className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold mb-1">コマ数（デフォルト）</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={panelCount}
                  onChange={(e) => setPanelCount(parseInt(e.target.value, 10) || 4)}
                  className="w-20 rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1">画風設定</label>
                <textarea
                  value={drawingStyle}
                  onChange={(e) => setDrawingStyle(e.target.value)}
                  placeholder="例: 白背景、黒のマジックペンで描かれたラフなイラスト漫画スタイル"
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 h-20"
                />
              </div>
              <button
                onClick={handleSaveSettings}
                disabled={isSaving}
                className="rounded-md border border-emerald-500 bg-emerald-600 px-4 py-1.5 text-xs font-semibold hover:bg-emerald-500 disabled:opacity-60"
              >
                {isSaving ? '保存中...' : '保存'}
              </button>
            </div>
          )}

          {activeSection === 'characters' && (
            <div className="space-y-4 text-xs">
              {/* キャラクター一覧 */}
              <div className="grid grid-cols-3 gap-3">
                {characters.map((char) => (
                  <div key={char.id} className="relative rounded-lg border border-slate-700 bg-slate-800 p-2">
                    {char.image_path ? (
                      <img
                        src={`/uploads/characters/${char.image_path}`}
                        alt={char.name}
                        className="w-full h-20 object-cover rounded mb-2"
                      />
                    ) : (
                      <div className="w-full h-20 bg-slate-700 rounded mb-2 flex items-center justify-center text-slate-500">
                        No Image
                      </div>
                    )}
                    <p className="font-semibold truncate">{char.name}</p>
                    {char.description && (
                      <p className="text-slate-400 truncate">{char.description}</p>
                    )}
                    <button
                      onClick={() => handleDeleteCharacter(char.id)}
                      className="absolute top-1 right-1 p-1 rounded bg-red-600/80 hover:bg-red-500"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>

              {/* 新規追加フォーム */}
              {characters.length < MAX_CHARACTERS && (
                <div className="border border-slate-700 rounded-lg p-3 space-y-2">
                  <p className="font-semibold">キャラクター追加</p>
                  <input
                    type="text"
                    value={newCharName}
                    onChange={(e) => setNewCharName(e.target.value)}
                    placeholder="キャラクター名"
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
                  />
                  <input
                    type="text"
                    value={newCharDesc}
                    onChange={(e) => setNewCharDesc(e.target.value)}
                    placeholder="説明（任意）"
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
                  />
                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-800 px-2 py-1 hover:bg-slate-700 cursor-pointer">
                      <Plus size={12} />
                      <span>画像選択</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) => setNewCharImage(e.target.files?.[0] || null)}
                        className="hidden"
                      />
                    </label>
                    {newCharPreview && (
                      <img src={newCharPreview} alt="Preview" className="w-10 h-10 object-cover rounded" />
                    )}
                  </div>
                  <button
                    onClick={handleAddCharacter}
                    disabled={isAddingChar}
                    className="rounded-md border border-emerald-500 bg-emerald-600 px-3 py-1 font-semibold hover:bg-emerald-500 disabled:opacity-60"
                  >
                    {isAddingChar ? '追加中...' : '追加'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
```

**Step 2: コミット**

```bash
git add client/src/components/SettingsPanel.jsx
git commit -m "feat: extend SettingsPanel with character management"
```

---

## Task 9: PrepareTab実装

**Files:**
- Create: `client/src/components/PrepareTab.jsx`

**Step 1: PrepareTabコンポーネント作成**

```jsx
import React, { useEffect, useState } from 'react';
import { Sparkles, Upload, X, Check } from 'lucide-react';
import api from '../api';

const PrepareTab = ({ date, comic, onComicUpdate }) => {
  const [theme, setTheme] = useState('');
  const [summary, setSummary] = useState('');
  const [characters, setCharacters] = useState([]);
  const [selectedCharIds, setSelectedCharIds] = useState([]);
  const [refImages, setRefImages] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [pendingPreviews, setPendingPreviews] = useState([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadCharacters();
  }, []);

  useEffect(() => {
    if (comic) {
      setTheme(comic.theme || '');
      setSummary(comic.summary || '');
      setSelectedCharIds(comic.selected_characters ? comic.selected_characters.split(',').filter(Boolean) : []);
      setRefImages(comic.ref_images ? comic.ref_images.split(',').filter(Boolean) : []);
    }
  }, [comic]);

  useEffect(() => {
    const urls = pendingFiles.map(f => URL.createObjectURL(f));
    setPendingPreviews(urls);
    return () => urls.forEach(u => URL.revokeObjectURL(u));
  }, [pendingFiles]);

  const loadCharacters = async () => {
    try {
      const res = await api.get('/characters');
      setCharacters(res.data || []);
    } catch (e) {
      console.error(e);
    }
  };

  const handleSuggest = async () => {
    setIsSuggesting(true);
    try {
      const res = await api.post(`/comics/${date}/suggest`);
      setTheme(res.data.theme || '');
      setSummary(res.data.summary || '');
    } catch (e) {
      console.error(e);
      alert('テーマ提案に失敗しました。');
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const formData = new FormData();
      formData.append('theme', theme);
      formData.append('summary', summary);
      formData.append('selected_characters', selectedCharIds.join(','));
      pendingFiles.forEach(file => {
        formData.append('ref_images', file);
      });

      const res = await api.post(`/comics/${date}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      onComicUpdate(res.data);
      setPendingFiles([]);
      alert('保存しました。');
    } catch (e) {
      console.error(e);
      alert('保存に失敗しました。');
    } finally {
      setIsSaving(false);
    }
  };

  const toggleCharacter = (id) => {
    const idStr = String(id);
    if (selectedCharIds.includes(idStr)) {
      setSelectedCharIds(selectedCharIds.filter(i => i !== idStr));
    } else {
      setSelectedCharIds([...selectedCharIds, idStr]);
    }
  };

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || []);
    setPendingFiles(prev => [...prev, ...files]);
    e.target.value = '';
  };

  const removePendingFile = (idx) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const handleDeleteRef = async (filename) => {
    try {
      await api.delete(`/comics/${date}/ref/${encodeURIComponent(filename)}`);
      setRefImages(refImages.filter(f => f !== filename));
    } catch (e) {
      console.error(e);
      alert('削除に失敗しました。');
    }
  };

  return (
    <div className="space-y-6">
      {/* テーマと概要 */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold">テーマ</label>
          <button
            onClick={handleSuggest}
            disabled={isSuggesting}
            className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
          >
            <Sparkles size={14} />
            {isSuggesting ? '提案中...' : 'AIで提案'}
          </button>
        </div>
        <input
          type="text"
          value={theme}
          onChange={(e) => setTheme(e.target.value)}
          placeholder="今日の漫画のテーマ"
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />

        <label className="text-sm font-semibold block">概要</label>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="起承転結を含む漫画の流れ"
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm h-24"
        />
      </div>

      {/* キャラクター選択 */}
      <div>
        <label className="text-sm font-semibold block mb-2">参照キャラクター</label>
        <div className="flex flex-wrap gap-2">
          {characters.map((char) => {
            const isSelected = selectedCharIds.includes(String(char.id));
            return (
              <button
                key={char.id}
                onClick={() => toggleCharacter(char.id)}
                className={`relative rounded-lg border p-1 transition-colors ${
                  isSelected
                    ? 'border-emerald-500 bg-emerald-900/30'
                    : 'border-slate-700 bg-slate-800 hover:border-slate-600'
                }`}
              >
                {char.image_path ? (
                  <img
                    src={`/uploads/characters/${char.image_path}`}
                    alt={char.name}
                    className="w-12 h-12 object-cover rounded"
                  />
                ) : (
                  <div className="w-12 h-12 bg-slate-700 rounded flex items-center justify-center text-xs text-slate-400">
                    {char.name.charAt(0)}
                  </div>
                )}
                <p className="text-[10px] mt-1 truncate max-w-[50px]">{char.name}</p>
                {isSelected && (
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center">
                    <Check size={10} />
                  </div>
                )}
              </button>
            );
          })}
          {characters.length === 0 && (
            <p className="text-xs text-slate-400">キャラクターが登録されていません。設定から追加してください。</p>
          )}
        </div>
      </div>

      {/* 追加参照画像 */}
      <div>
        <label className="text-sm font-semibold block mb-2">追加参照画像（背景・小物など）</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {refImages.map((filename) => (
            <div key={filename} className="relative">
              <img
                src={`/uploads/comic_refs/${filename}`}
                alt={filename}
                className="w-16 h-16 object-cover rounded border border-slate-600"
              />
              <button
                onClick={() => handleDeleteRef(filename)}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-600 text-white text-[10px] flex items-center justify-center hover:bg-red-500"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {pendingPreviews.map((url, idx) => (
            <div key={url} className="relative">
              <img
                src={url}
                alt={`追加予定 ${idx + 1}`}
                className="w-16 h-16 object-cover rounded border border-emerald-500"
              />
              <button
                onClick={() => removePendingFile(idx)}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-slate-600 text-white text-[10px] flex items-center justify-center hover:bg-slate-500"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs hover:bg-slate-700 cursor-pointer">
          <Upload size={12} />
          <span>画像を追加</span>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />
        </label>
      </div>

      {/* 保存ボタン */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="rounded-md border border-emerald-500 bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-60"
        >
          {isSaving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
};

export default PrepareTab;
```

**Step 2: コミット**

```bash
git add client/src/components/PrepareTab.jsx
git commit -m "feat: add PrepareTab component for comic preparation"
```

---

## Task 10: GenerateTab実装

**Files:**
- Create: `client/src/components/GenerateTab.jsx`

**Step 1: GenerateTabコンポーネント作成**

```jsx
import React, { useState, useEffect } from 'react';
import { Play, Loader2 } from 'lucide-react';
import api from '../api';

const GenerateTab = ({ date, comic, onComicUpdate }) => {
  const [panelCount, setPanelCount] = useState(4);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await api.get('/settings');
      setPanelCount(res.data.panel_count || 4);
    } catch (e) {
      console.error(e);
    }
  };

  const handleGenerate = async () => {
    if (!comic?.theme) {
      alert('先に「準備」タブでテーマを設定してください。');
      return;
    }

    setIsGenerating(true);
    setProgress({ current: 0, total: panelCount });

    try {
      // 漫画のステータスを生成中に更新
      await api.post(`/comics/${date}`, { status: 'generating' });

      const res = await api.post(`/comics/${date}/generate`, {
        panel_count: panelCount
      });

      onComicUpdate(res.data);
      alert('漫画の生成が完了しました！');
    } catch (e) {
      console.error(e);
      alert(e.response?.data?.error || '生成に失敗しました。');
    } finally {
      setIsGenerating(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  const panels = comic?.panels || [];
  const generatedCount = panels.filter(p => p.status !== 'ungenerated').length;

  return (
    <div className="space-y-6">
      {/* 生成設定 */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
        <h3 className="text-sm font-semibold mb-3">生成設定</h3>
        <div className="flex items-center gap-4 text-sm">
          <label>コマ数:</label>
          <input
            type="number"
            min="1"
            max="10"
            value={panelCount}
            onChange={(e) => setPanelCount(parseInt(e.target.value, 10) || 4)}
            disabled={isGenerating}
            className="w-16 rounded-md border border-slate-600 bg-slate-900 px-2 py-1"
          />
        </div>
      </div>

      {/* 現在の状態 */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
        <h3 className="text-sm font-semibold mb-3">現在の状態</h3>
        <div className="text-sm space-y-2">
          <p>テーマ: {comic?.theme || <span className="text-slate-400">未設定</span>}</p>
          <p>概要: {comic?.summary || <span className="text-slate-400">未設定</span>}</p>
          <p>生成済みコマ: {generatedCount} / {panels.length || panelCount}</p>
        </div>
      </div>

      {/* プログレス表示 */}
      {isGenerating && (
        <div className="rounded-lg border border-amber-600 bg-amber-900/20 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 size={16} className="animate-spin text-amber-400" />
            <span className="text-sm font-medium text-amber-400">生成中...</span>
          </div>
          <div className="w-full bg-slate-700 rounded-full h-2">
            <div
              className="bg-amber-500 h-2 rounded-full transition-all"
              style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
            />
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {progress.current} / {progress.total} コマ完了
          </p>
        </div>
      )}

      {/* 生成ボタン */}
      <div className="flex justify-center">
        <button
          onClick={handleGenerate}
          disabled={isGenerating || !comic?.theme}
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-500 bg-emerald-600 px-6 py-3 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {isGenerating ? (
            <>
              <Loader2 size={18} className="animate-spin" />
              生成中...
            </>
          ) : (
            <>
              <Play size={18} />
              まんが生成
            </>
          )}
        </button>
      </div>

      {!comic?.theme && (
        <p className="text-center text-xs text-amber-400">
          ※ 先に「準備」タブでテーマと概要を設定してください
        </p>
      )}
    </div>
  );
};

export default GenerateTab;
```

**Step 2: コミット**

```bash
git add client/src/components/GenerateTab.jsx
git commit -m "feat: add GenerateTab component"
```

---

## Task 11: 漫画生成API実装

**Files:**
- Modify: `server/index.js`

**Step 1: 漫画生成APIを追加**

```javascript
// 漫画生成（全コマ一括）
app.post('/api/comics/:date/generate', async (req, res) => {
  const { date } = req.params;
  const { panel_count } = req.body;

  try {
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic || !comic.theme) {
      return res.status(400).json({ error: 'テーマが設定されていません。' });
    }

    const panelCountSetting = panel_count || parseInt(await getSetting('panel_count'), 10) || 4;
    const drawingStyle = (await getSetting('drawing_style')) || '白背景、黒のマジックペンで描かれたラフなイラスト漫画スタイル';

    // 選択されたキャラクター情報を取得
    let characterInfo = '';
    if (comic.selected_characters) {
      const charIds = comic.selected_characters.split(',').filter(Boolean);
      if (charIds.length > 0) {
        const placeholders = charIds.map(() => '?').join(',');
        const chars = await all(`SELECT * FROM characters WHERE id IN (${placeholders})`, charIds);
        characterInfo = chars.map(c => `- ${c.name}: ${c.description || '説明なし'}`).join('\n');
      }
    }

    // まずテキストモデルで各コマの内容を生成
    const textModel = getTextModel();
    const panelPlanPrompt = `
あなたは4コマ漫画のシナリオライターです。
以下のテーマと概要から、${panelCountSetting}コマ漫画の各コマの内容を具体的に決めてください。

テーマ: ${comic.theme}
概要: ${comic.summary || '特になし'}
${characterInfo ? `\n登場キャラクター:\n${characterInfo}` : ''}

各コマについて、以下を含む具体的な描写を日本語で書いてください:
- 構図
- キャラクターの配置とポーズ
- 表情
- セリフ（吹き出し内のテキスト）

出力形式（JSON配列）:
[
  {"panel": 1, "description": "1コマ目の詳細な描写..."},
  {"panel": 2, "description": "2コマ目の詳細な描写..."},
  ...
]

JSON配列のみを返してください。
`;

    const planResult = await textModel.generateContent(panelPlanPrompt);
    const planText = planResult.response.text();
    const planMatch = planText.match(/\[[\s\S]*\]/);
    if (!planMatch) {
      return res.status(500).json({ error: 'コマ割りの生成に失敗しました。' });
    }
    const panelPlans = JSON.parse(planMatch[0]);

    // 画像生成モデル
    const imageModel = getImageModel();

    // 各コマの生成
    const generatedPanels = [];
    for (let i = 0; i < panelCountSetting; i++) {
      const panelNum = i + 1;
      const plan = panelPlans.find(p => p.panel === panelNum) || { description: `${panelNum}コマ目` };

      const imagePrompt = `
【画風】
${drawingStyle}

【漫画の設定】
${panelCountSetting}コマ漫画の${panelNum}コマ目

【このコマの内容】
${plan.description}

【注意】
- セリフや吹き出しは描かないでください
- 1コマの正方形のイラストとして描いてください
- 背景は白またはシンプルに
`;

      // キャラクター参照画像を添付
      const contents = [];
      if (comic.selected_characters) {
        const charIds = comic.selected_characters.split(',').filter(Boolean);
        for (const charId of charIds) {
          const char = await get('SELECT * FROM characters WHERE id = ?', [charId]);
          if (char?.image_path) {
            const charImgPath = path.join(UPLOADS_DIR, 'characters', char.image_path);
            if (fs.existsSync(charImgPath)) {
              const { buffer, mimeType } = await prepareRefImageForApi(charImgPath);
              contents.push({
                inlineData: { data: buffer.toString('base64'), mimeType }
              });
            }
          }
        }
      }

      // 追加参照画像
      if (comic.ref_images) {
        const refFiles = comic.ref_images.split(',').filter(Boolean);
        for (const refFile of refFiles) {
          const refPath = path.join(UPLOADS_DIR, 'comic_refs', refFile);
          if (fs.existsSync(refPath)) {
            const { buffer, mimeType } = await prepareRefImageForApi(refPath);
            contents.push({
              inlineData: { data: buffer.toString('base64'), mimeType }
            });
          }
        }
      }

      contents.push({ text: imagePrompt });

      console.log(`コマ ${panelNum} を生成中...`);
      const result = await imageModel.generateContent(contents);
      const candidate = result.response.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const imgPart = parts.find(p => p.inlineData);

      if (!imgPart) {
        console.warn(`コマ ${panelNum} の画像生成に失敗`);
        continue;
      }

      const imgBuffer = Buffer.from(imgPart.inlineData.data, 'base64');
      const filename = `${date}-panel-${panelNum}-${Date.now()}.png`;
      const outPath = path.join(GENERATED_DIR, filename);
      fs.writeFileSync(outPath, imgBuffer);

      // DBに保存
      await run(`
        INSERT INTO panels (comic_date, panel_number, image_path, status)
        VALUES (?, ?, ?, 'generated')
        ON CONFLICT(comic_date, panel_number) DO UPDATE SET
          image_path = excluded.image_path,
          status = 'generated'
      `, [date, panelNum, filename]);

      generatedPanels.push({ panel_number: panelNum, image_path: filename, status: 'generated' });
    }

    // 漫画のステータスを完成に更新
    await run('UPDATE comics SET status = ? WHERE date = ?', ['completed', date]);

    const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const allPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);

    res.json({ ...updatedComic, panels: allPanels });
  } catch (err) {
    console.error('漫画生成エラー:', err);
    res.status(500).json({ error: '漫画の生成に失敗しました。', details: err.message });
  }
});
```

**Step 2: コミット**

```bash
git add server/index.js
git commit -m "feat: add comic generation API"
```

---

## Task 12: AdjustTab実装

**Files:**
- Create: `client/src/components/AdjustTab.jsx`

**Step 1: AdjustTabコンポーネント作成**

```jsx
import React, { useState } from 'react';
import { RefreshCw, Paintbrush, Check, Loader2 } from 'lucide-react';
import api from '../api';
import PanelEditor from './PanelEditor';

const AdjustTab = ({ date, comic, onComicUpdate }) => {
  const [selectedPanel, setSelectedPanel] = useState(null);
  const [regeneratePrompt, setRegeneratePrompt] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [showInpaint, setShowInpaint] = useState(false);

  const panels = comic?.panels || [];

  const handleRegenerate = async (panelNum) => {
    if (!regeneratePrompt.trim()) {
      alert('修正指示を入力してください。');
      return;
    }
    setIsRegenerating(true);
    try {
      const res = await api.post(`/comics/${date}/panels/${panelNum}/regenerate`, {
        prompt: regeneratePrompt
      });
      onComicUpdate(res.data);
      setRegeneratePrompt('');
      setSelectedPanel(null);
      alert('再生成が完了しました。');
    } catch (e) {
      console.error(e);
      alert(e.response?.data?.error || '再生成に失敗しました。');
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleApprove = async (panelNum) => {
    try {
      const res = await api.post(`/comics/${date}/panels/${panelNum}/status`, {
        status: 'approved'
      });
      onComicUpdate(res.data);
    } catch (e) {
      console.error(e);
      alert('ステータス更新に失敗しました。');
    }
  };

  const handleInpaintComplete = (updatedComic) => {
    onComicUpdate(updatedComic);
    setShowInpaint(false);
    setSelectedPanel(null);
  };

  if (panels.length === 0) {
    return (
      <div className="text-center text-slate-400 py-12">
        まだコマが生成されていません。「生成」タブから漫画を生成してください。
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* コマ一覧 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {panels.map((panel) => (
          <div
            key={panel.panel_number}
            className={`relative rounded-lg border-2 p-2 cursor-pointer transition-colors ${
              selectedPanel === panel.panel_number
                ? 'border-emerald-500 bg-emerald-900/20'
                : panel.status === 'approved'
                ? 'border-emerald-600/50 bg-slate-800'
                : 'border-slate-700 bg-slate-800 hover:border-slate-600'
            }`}
            onClick={() => setSelectedPanel(panel.panel_number)}
          >
            <div className="absolute top-1 left-1 bg-slate-900/80 rounded px-1 text-[10px]">
              {panel.panel_number}コマ目
            </div>
            {panel.status === 'approved' && (
              <div className="absolute top-1 right-1 bg-emerald-600 rounded-full p-0.5">
                <Check size={10} />
              </div>
            )}
            {panel.image_path ? (
              <img
                src={`/generated/${panel.image_path}`}
                alt={`コマ ${panel.panel_number}`}
                className="w-full aspect-square object-cover rounded"
              />
            ) : (
              <div className="w-full aspect-square bg-slate-700 rounded flex items-center justify-center text-slate-500">
                未生成
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 選択したコマの編集パネル */}
      {selectedPanel && !showInpaint && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 space-y-4">
          <h3 className="text-sm font-semibold">{selectedPanel}コマ目の編集</h3>

          <div className="flex gap-2">
            <button
              onClick={() => handleApprove(selectedPanel)}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-500 bg-emerald-600 px-3 py-1.5 text-xs hover:bg-emerald-500"
            >
              <Check size={14} />
              承認
            </button>
            <button
              onClick={() => setShowInpaint(true)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-600 bg-slate-700 px-3 py-1.5 text-xs hover:bg-slate-600"
            >
              <Paintbrush size={14} />
              Inpaint
            </button>
          </div>

          <div>
            <label className="text-xs font-medium block mb-1">再生成（テキスト指示）</label>
            <textarea
              value={regeneratePrompt}
              onChange={(e) => setRegeneratePrompt(e.target.value)}
              placeholder="例: 表情をもっと驚いた感じにして"
              className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm h-20"
            />
            <button
              onClick={() => handleRegenerate(selectedPanel)}
              disabled={isRegenerating}
              className="mt-2 inline-flex items-center gap-1 rounded-md border border-amber-500 bg-amber-600 px-3 py-1.5 text-xs hover:bg-amber-500 disabled:opacity-60"
            >
              {isRegenerating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <RefreshCw size={14} />
              )}
              {isRegenerating ? '再生成中...' : '再生成'}
            </button>
          </div>
        </div>
      )}

      {/* Inpaintモード */}
      {showInpaint && selectedPanel && (
        <PanelEditor
          date={date}
          panelNumber={selectedPanel}
          imagePath={panels.find(p => p.panel_number === selectedPanel)?.image_path}
          onComplete={handleInpaintComplete}
          onCancel={() => setShowInpaint(false)}
        />
      )}
    </div>
  );
};

export default AdjustTab;
```

**Step 2: コミット**

```bash
git add client/src/components/AdjustTab.jsx
git commit -m "feat: add AdjustTab component for panel editing"
```

---

## Task 13: PanelEditor実装（Inpaint）

**Files:**
- Create: `client/src/components/PanelEditor.jsx`

**Step 1: PanelEditorコンポーネント作成**

```jsx
import React, { useRef, useState, useEffect } from 'react';
import { Eraser, Paintbrush, Send, X, Loader2 } from 'lucide-react';
import api from '../api';

const PanelEditor = ({ date, panelNumber, imagePath, onComplete, onCancel }) => {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(20);
  const [tool, setTool] = useState('brush'); // brush or eraser
  const [prompt, setPrompt] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  useEffect(() => {
    if (!imagePath) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setImageLoaded(true);
    };
    img.src = `/generated/${imagePath}`;
  }, [imagePath]);

  const getMousePos = (e) => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };

  const startDrawing = (e) => {
    setIsDrawing(true);
    draw(e);
  };

  const stopDrawing = () => {
    setIsDrawing(false);
  };

  const draw = (e) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const pos = getMousePos(e);

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, brushSize / 2, 0, Math.PI * 2);
    if (tool === 'brush') {
      ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
      ctx.fill();
    } else {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  };

  const clearMask = () => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const handleSubmit = async () => {
    if (!prompt.trim()) {
      alert('修正指示を入力してください。');
      return;
    }

    const canvas = canvasRef.current;
    const maskDataUrl = canvas.toDataURL('image/png');

    setIsProcessing(true);
    try {
      const res = await api.post(`/comics/${date}/panels/${panelNumber}/inpaint`, {
        mask: maskDataUrl,
        prompt: prompt
      });
      onComplete(res.data);
    } catch (e) {
      console.error(e);
      alert(e.response?.data?.error || 'Inpaintに失敗しました。');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Inpaint編集 - {panelNumber}コマ目</h3>
        <button onClick={onCancel} className="text-slate-400 hover:text-slate-200">
          <X size={18} />
        </button>
      </div>

      <p className="text-xs text-slate-400">
        修正したい部分を赤くマスクしてください。マスクした領域が再生成されます。
      </p>

      {/* ツールバー */}
      <div className="flex items-center gap-4">
        <div className="flex gap-1">
          <button
            onClick={() => setTool('brush')}
            className={`p-2 rounded ${tool === 'brush' ? 'bg-emerald-600' : 'bg-slate-700'}`}
          >
            <Paintbrush size={16} />
          </button>
          <button
            onClick={() => setTool('eraser')}
            className={`p-2 rounded ${tool === 'eraser' ? 'bg-emerald-600' : 'bg-slate-700'}`}
          >
            <Eraser size={16} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs">ブラシサイズ:</label>
          <input
            type="range"
            min="5"
            max="50"
            value={brushSize}
            onChange={(e) => setBrushSize(parseInt(e.target.value, 10))}
            className="w-24"
          />
          <span className="text-xs w-6">{brushSize}</span>
        </div>
        <button
          onClick={clearMask}
          className="text-xs text-slate-400 hover:text-slate-200"
        >
          マスククリア
        </button>
      </div>

      {/* キャンバス */}
      <div className="relative bg-slate-900 rounded overflow-hidden">
        {imagePath && (
          <img
            src={`/generated/${imagePath}`}
            alt="元画像"
            className="w-full"
          />
        )}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          onMouseDown={startDrawing}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onMouseMove={draw}
        />
      </div>

      {/* 指示入力 */}
      <div>
        <label className="text-xs font-medium block mb-1">修正指示</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="例: マスクした部分を笑顔に変更して"
          className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm h-16"
        />
      </div>

      {/* 実行ボタン */}
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-slate-600 bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600"
        >
          キャンセル
        </button>
        <button
          onClick={handleSubmit}
          disabled={isProcessing}
          className="inline-flex items-center gap-2 rounded-md border border-emerald-500 bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-60"
        >
          {isProcessing ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              処理中...
            </>
          ) : (
            <>
              <Send size={16} />
              Inpaint実行
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default PanelEditor;
```

**Step 2: コミット**

```bash
git add client/src/components/PanelEditor.jsx
git commit -m "feat: add PanelEditor component with inpaint canvas"
```

---

## Task 14: コマ再生成・InpaintAPI実装

**Files:**
- Modify: `server/index.js`

**Step 1: コマ再生成APIを追加**

```javascript
// コマ再生成（テキスト指示）
app.post('/api/comics/:date/panels/:num/regenerate', async (req, res) => {
  const { date, num } = req.params;
  const { prompt } = req.body;
  const panelNum = parseInt(num, 10);

  try {
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    if (!comic) {
      return res.status(404).json({ error: '漫画が見つかりません。' });
    }

    const drawingStyle = (await getSetting('drawing_style')) || '白背景、黒のマジックペンで描かれたラフなイラスト漫画スタイル';

    const imagePrompt = `
【画風】
${drawingStyle}

【元の漫画情報】
テーマ: ${comic.theme}
概要: ${comic.summary}

【このコマの修正指示】
${prompt}

【注意】
- セリフや吹き出しは描かないでください
- 1コマの正方形のイラストとして描いてください
`;

    const contents = [];

    // キャラクター参照画像
    if (comic.selected_characters) {
      const charIds = comic.selected_characters.split(',').filter(Boolean);
      for (const charId of charIds) {
        const char = await get('SELECT * FROM characters WHERE id = ?', [charId]);
        if (char?.image_path) {
          const charImgPath = path.join(UPLOADS_DIR, 'characters', char.image_path);
          if (fs.existsSync(charImgPath)) {
            const { buffer, mimeType } = await prepareRefImageForApi(charImgPath);
            contents.push({ inlineData: { data: buffer.toString('base64'), mimeType } });
          }
        }
      }
    }

    contents.push({ text: imagePrompt });

    const imageModel = getImageModel();
    const result = await imageModel.generateContent(contents);
    const candidate = result.response.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData);

    if (!imgPart) {
      return res.status(500).json({ error: '画像生成に失敗しました。' });
    }

    const imgBuffer = Buffer.from(imgPart.inlineData.data, 'base64');
    const filename = `${date}-panel-${panelNum}-${Date.now()}.png`;
    const outPath = path.join(GENERATED_DIR, filename);
    fs.writeFileSync(outPath, imgBuffer);

    await run(`
      UPDATE panels SET image_path = ?, status = 'generated'
      WHERE comic_date = ? AND panel_number = ?
    `, [filename, date, panelNum]);

    const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const allPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    res.json({ ...updatedComic, panels: allPanels });
  } catch (err) {
    console.error('コマ再生成エラー:', err);
    res.status(500).json({ error: 'コマの再生成に失敗しました。', details: err.message });
  }
});

// コマInpaint
app.post('/api/comics/:date/panels/:num/inpaint', async (req, res) => {
  const { date, num } = req.params;
  const { mask, prompt } = req.body;
  const panelNum = parseInt(num, 10);

  try {
    const comic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const panel = await get('SELECT * FROM panels WHERE comic_date = ? AND panel_number = ?', [date, panelNum]);

    if (!comic || !panel) {
      return res.status(404).json({ error: 'コマが見つかりません。' });
    }

    const drawingStyle = (await getSetting('drawing_style')) || '白背景、黒のマジックペンで描かれたラフなイラスト漫画スタイル';

    // 元画像を読み込み
    const originalPath = path.join(GENERATED_DIR, panel.image_path);
    if (!fs.existsSync(originalPath)) {
      return res.status(404).json({ error: '元画像が見つかりません。' });
    }
    const originalBuffer = fs.readFileSync(originalPath);
    const originalBase64 = originalBuffer.toString('base64');

    // マスク画像（Data URL形式）からbase64を抽出
    const maskBase64 = mask.replace(/^data:image\/\w+;base64,/, '');

    const inpaintPrompt = `
【重要】これはInpaint（部分修正）タスクです。

1枚目の画像: 元の漫画イラスト
2枚目の画像: マスク（赤い部分が修正対象）

【画風】
${drawingStyle}

【修正指示】
マスクされた赤い領域のみを以下の指示に従って修正してください:
${prompt}

【注意】
- マスクされていない部分は変更しないでください
- 元の絵のスタイルを維持してください
- セリフや吹き出しは描かないでください
`;

    const contents = [
      { inlineData: { data: originalBase64, mimeType: 'image/png' } },
      { inlineData: { data: maskBase64, mimeType: 'image/png' } },
      { text: inpaintPrompt }
    ];

    const imageModel = getImageModel();
    const result = await imageModel.generateContent(contents);
    const candidate = result.response.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData);

    if (!imgPart) {
      return res.status(500).json({ error: 'Inpaintに失敗しました。' });
    }

    const imgBuffer = Buffer.from(imgPart.inlineData.data, 'base64');
    const filename = `${date}-panel-${panelNum}-inpaint-${Date.now()}.png`;
    const outPath = path.join(GENERATED_DIR, filename);
    fs.writeFileSync(outPath, imgBuffer);

    await run(`
      UPDATE panels SET image_path = ?, status = 'generated'
      WHERE comic_date = ? AND panel_number = ?
    `, [filename, date, panelNum]);

    const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const allPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    res.json({ ...updatedComic, panels: allPanels });
  } catch (err) {
    console.error('Inpaintエラー:', err);
    res.status(500).json({ error: 'Inpaintに失敗しました。', details: err.message });
  }
});

// コマステータス更新
app.post('/api/comics/:date/panels/:num/status', async (req, res) => {
  const { date, num } = req.params;
  const { status } = req.body;
  const panelNum = parseInt(num, 10);

  try {
    await run(`
      UPDATE panels SET status = ?
      WHERE comic_date = ? AND panel_number = ?
    `, [status, date, panelNum]);

    const updatedComic = await get('SELECT * FROM comics WHERE date = ?', [date]);
    const allPanels = await all('SELECT * FROM panels WHERE comic_date = ? ORDER BY panel_number', [date]);
    res.json({ ...updatedComic, panels: allPanels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ステータス更新に失敗しました。' });
  }
});
```

**Step 2: コミット**

```bash
git add server/index.js
git commit -m "feat: add panel regenerate and inpaint APIs"
```

---

## Task 15: OutputTab実装

**Files:**
- Create: `client/src/components/OutputTab.jsx`

**Step 1: OutputTabコンポーネント作成**

```jsx
import React, { useState, useEffect, useRef } from 'react';
import { Download, Save, Loader2 } from 'lucide-react';
import api from '../api';

const OutputTab = ({ date, comic }) => {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const canvasRef = useRef(null);

  const panels = comic?.panels || [];
  const generatedPanels = panels.filter(p => p.image_path);

  useEffect(() => {
    if (generatedPanels.length > 0) {
      generatePreview();
    }
  }, [panels]);

  const generatePreview = async () => {
    if (generatedPanels.length === 0) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');

    // 縦に並べる
    const panelSize = 512;
    canvas.width = panelSize;
    canvas.height = panelSize * generatedPanels.length;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < generatedPanels.length; i++) {
      const panel = generatedPanels[i];
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `/generated/${panel.image_path}`;
      });
      ctx.drawImage(img, 0, i * panelSize, panelSize, panelSize);
    }

    setPreviewUrl(canvas.toDataURL('image/png'));
  };

  const handleDownload = () => {
    if (!previewUrl) return;
    const link = document.createElement('a');
    link.download = `comic-${date}.png`;
    link.href = previewUrl;
    link.click();
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const canvas = canvasRef.current;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const formData = new FormData();
      formData.append('image', blob, `comic-${date}.png`);

      await api.post(`/comics/${date}/save`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      alert('出力フォルダに保存しました。');
    } catch (e) {
      console.error(e);
      alert(e.response?.data?.error || '保存に失敗しました。');
    } finally {
      setIsSaving(false);
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const res = await api.get(`/comics/${date}/export`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const link = document.createElement('a');
      link.download = `comic-${date}.png`;
      link.href = url;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error(e);
      alert('エクスポートに失敗しました。');
    } finally {
      setIsExporting(false);
    }
  };

  if (generatedPanels.length === 0) {
    return (
      <div className="text-center text-slate-400 py-12">
        まだコマが生成されていません。「生成」タブから漫画を生成してください。
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 隠しキャンバス */}
      <canvas ref={canvasRef} className="hidden" />

      {/* プレビュー */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
        <h3 className="text-sm font-semibold mb-3">結合プレビュー</h3>
        {previewUrl ? (
          <div className="flex justify-center">
            <img
              src={previewUrl}
              alt="結合プレビュー"
              className="max-h-[60vh] object-contain rounded border border-slate-600"
            />
          </div>
        ) : (
          <div className="text-center text-slate-400 py-8">
            プレビュー生成中...
          </div>
        )}
      </div>

      {/* 出力ボタン */}
      <div className="flex justify-center gap-4">
        <button
          onClick={handleDownload}
          disabled={!previewUrl}
          className="inline-flex items-center gap-2 rounded-md border border-slate-600 bg-slate-700 px-4 py-2 text-sm hover:bg-slate-600 disabled:opacity-60"
        >
          <Download size={16} />
          ダウンロード
        </button>
        <button
          onClick={handleSave}
          disabled={!previewUrl || isSaving}
          className="inline-flex items-center gap-2 rounded-md border border-emerald-500 bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-60"
        >
          {isSaving ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Save size={16} />
          )}
          {isSaving ? '保存中...' : '出力フォルダに保存'}
        </button>
      </div>

      {/* 個別コマ表示 */}
      <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
        <h3 className="text-sm font-semibold mb-3">個別コマ</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {generatedPanels.map((panel) => (
            <div key={panel.panel_number} className="relative">
              <img
                src={`/generated/${panel.image_path}`}
                alt={`コマ ${panel.panel_number}`}
                className="w-full rounded border border-slate-600"
              />
              <span className="absolute top-1 left-1 bg-slate-900/80 rounded px-1 text-[10px]">
                {panel.panel_number}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default OutputTab;
```

**Step 2: コミット**

```bash
git add client/src/components/OutputTab.jsx
git commit -m "feat: add OutputTab component with preview and export"
```

---

## Task 16: 出力保存API実装

**Files:**
- Modify: `server/index.js`

**Step 1: 出力API追加**

```javascript
// 出力フォルダ用Multer
const outputStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const outputDir = path.join(ROOT_DIR, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    cb(null, outputDir);
  },
  filename: (req, file, cb) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `comic-${timestamp}.png`);
  }
});
const outputUpload = multer({ storage: outputStorage });

// 結合画像をサーバーで生成してダウンロード
app.get('/api/comics/:date/export', async (req, res) => {
  const { date } = req.params;

  try {
    const panels = await all(
      'SELECT * FROM panels WHERE comic_date = ? AND image_path IS NOT NULL ORDER BY panel_number',
      [date]
    );

    if (panels.length === 0) {
      return res.status(400).json({ error: '生成済みのコマがありません。' });
    }

    // Sharp で縦に結合
    const panelImages = [];
    for (const panel of panels) {
      const imgPath = path.join(GENERATED_DIR, panel.image_path);
      if (fs.existsSync(imgPath)) {
        panelImages.push(imgPath);
      }
    }

    if (panelImages.length === 0) {
      return res.status(400).json({ error: '画像ファイルが見つかりません。' });
    }

    // 最初の画像でサイズを取得
    const firstMeta = await sharp(panelImages[0]).metadata();
    const panelWidth = firstMeta.width || 512;
    const panelHeight = firstMeta.height || 512;

    // 全パネルをリサイズして配列に
    const resizedBuffers = await Promise.all(
      panelImages.map(p =>
        sharp(p)
          .resize(panelWidth, panelHeight, { fit: 'cover' })
          .toBuffer()
      )
    );

    // 縦に結合
    const composite = resizedBuffers.map((buf, i) => ({
      input: buf,
      top: i * panelHeight,
      left: 0
    }));

    const outputBuffer = await sharp({
      create: {
        width: panelWidth,
        height: panelHeight * panelImages.length,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .composite(composite)
      .png()
      .toBuffer();

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', `attachment; filename="comic-${date}.png"`);
    res.send(outputBuffer);
  } catch (err) {
    console.error('エクスポートエラー:', err);
    res.status(500).json({ error: 'エクスポートに失敗しました。', details: err.message });
  }
});

// 出力フォルダに保存
app.post('/api/comics/:date/save', outputUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '画像ファイルがありません。' });
    }
    res.json({ ok: true, path: req.file.path });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '保存に失敗しました。' });
  }
});
```

**Step 2: コミット**

```bash
git add server/index.js
git commit -m "feat: add export and save APIs for comic output"
```

---

## Task 17: 最終統合とテスト

**Step 1: 全ファイルの確認**

Run: `cd /Library/WebServer/Documents/html/raiu/comic01 && ls -la client/src/components/`

**Step 2: サーバー起動テスト**

Run: `npm run dev:server`
Expected: エラーなく起動

**Step 3: クライアント起動テスト**

Run: `npm run dev`
Expected: エラーなく起動、ブラウザでUIが表示される

**Step 4: 最終コミット**

```bash
git add -A
git commit -m "feat: complete 4-panel comic creation app implementation"
git push origin main
```

---

## 実装チェックリスト

- [ ] Task 1: DBスキーマ変更
- [ ] Task 2: キャラクターAPI
- [ ] Task 3: 基本設定API
- [ ] Task 4: 漫画CRUD API
- [ ] Task 5: AI提案API
- [ ] Task 6: App.jsx タブUI化
- [ ] Task 7: CalendarView更新
- [ ] Task 8: SettingsPanel拡張
- [ ] Task 9: PrepareTab実装
- [ ] Task 10: GenerateTab実装
- [ ] Task 11: 漫画生成API
- [ ] Task 12: AdjustTab実装
- [ ] Task 13: PanelEditor実装
- [ ] Task 14: コマ再生成・InpaintAPI
- [ ] Task 15: OutputTab実装
- [ ] Task 16: 出力保存API
- [ ] Task 17: 最終統合とテスト
