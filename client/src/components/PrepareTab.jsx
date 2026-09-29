import React, { useEffect, useState, useMemo } from 'react';
import { Sparkles, Upload, X, Check, Layout, MessageCircle } from 'lucide-react';
import api from '../api';
import { normalizeCompositionNotation, testSerifDetection } from '../utils/serifOverlay';

/** セリフ検出プレビューコンポーネント */
const SerifPreview = ({ content }) => {
  const result = useMemo(() => testSerifDetection(content || ''), [content]);

  if (!content || !content.trim()) {
    return null;
  }

  if (result.detected) {
    return (
      <div className="mt-1.5 p-2 rounded-md bg-green-50 border border-green-200">
        <div className="flex items-center gap-1 text-green-700 text-xs font-medium mb-1">
          <MessageCircle size={12} />
          <span>セリフ検出: {result.count}件</span>
        </div>
        <div className="space-y-0.5">
          {result.serifs.map((s, idx) => (
            <div key={idx} className="text-xs text-green-800 truncate">
              {s.speaker ? (
                <span><span className="font-medium">{s.speaker}</span>「{s.text.length > 30 ? s.text.substring(0, 30) + '…' : s.text}」</span>
              ) : (
                <span>「{s.text.length > 30 ? s.text.substring(0, 30) + '…' : s.text}」</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // セリフ形式のヒントが含まれているか（【】のみセリフとして認識。「」は構成説明用のため対象外）
  const hasHint = content.includes('【') || content.includes('】') || content.includes('[') || content.includes(':') || content.includes('：');
  if (hasHint) {
    return (
      <div className="mt-1.5 p-2 rounded-md bg-amber-50 border border-amber-200">
        <div className="flex items-start gap-1.5 text-amber-700 text-xs">
          <MessageCircle size={12} className="mt-0.5 flex-shrink-0" />
          <div>
            <span className="font-medium">セリフ未検出</span>
            <p className="text-amber-600 mt-0.5">
              セリフは【発話者：セリフ内容】の形式で記述してください。<br />
              例: 【子供：もういいかーい】【そうべい：まあだだよー】
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

/** テーマ条件のカテゴリ */
const THEME_CATEGORIES = [
  { value: 'auto', label: 'おまかせ' },
  { value: 'japan_events', label: '日本で起きた出来事' },
  { value: 'non_japan_events', label: '日本以外の地域で起きた出来事' },
  { value: 'japan_trends', label: '日本で流行っていた事' },
  { value: 'non_japan_trends', label: '日本以外の地域で流行っていた事' },
];

/** 地域サブカテゴリ（日本以外を選んだときのみ表示） */
const THEME_REGIONS = [
  { value: 'none', label: '指定なし' },
  { value: 'americas', label: 'アメリカ' },
  { value: 'europe', label: 'ヨーロッパ' },
  { value: 'china', label: '中国' },
  { value: 'india', label: 'インド' },
  { value: 'asia', label: 'アジア（東南アジア・朝鮮半島など）' },
  { value: 'africa', label: 'アフリカ' },
  { value: 'latin_america', label: '中南米' },
  { value: 'middle_east', label: '中近東' },
  { value: 'russia_central_asia', label: 'ロシア・中央アジア・モンゴル' },
];

const PrepareTab = ({ date, comic, onComicUpdate }) => {
  const [panelCount, setPanelCount] = useState(4);
  const [theme, setTheme] = useState('');
  const [episodeSummary, setEpisodeSummary] = useState('');
  const [themeCategory, setThemeCategory] = useState('auto');
  const [themeRegion, setThemeRegion] = useState('none');
  const [composition, setComposition] = useState([]);
  // 1コマごとの大まかな縦横比（レイアウト指示用）
  // - landscape: 横長（例: 4:3）
  // - square: 正方形（例: 1:1）
  // - portrait: 縦長（例: 3:4）
  const [panelAspects, setPanelAspects] = useState([]);
  const [characters, setCharacters] = useState([]);
  const [selectedCharIds, setSelectedCharIds] = useState([]);
  const [refImages, setRefImages] = useState([]);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [pendingPreviews, setPendingPreviews] = useState([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isSuggestingStructure, setIsSuggestingStructure] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadCharacters();
    (async () => {
      try {
        const res = await api.get('/settings');
        setPanelCount(res.data.panel_count || 4);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  useEffect(() => {
    if (comic) {
      setTheme(comic.theme || '');
      setEpisodeSummary(comic.episode_summary || '');
      const raw = comic.summary || '';
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const arr = [];
          const aspectArr = [];
          for (let i = 0; i < panelCount; i++) {
            const item = parsed.find(p => Number(p.panel) === i + 1);
            arr.push(normalizeCompositionNotation(item?.content ?? item?.description ?? ''));
            const a = item?.aspect ?? 'square';
            aspectArr.push((a === 'landscape' || a === 'portrait' || a === 'square') ? a : 'square');
          }
          setComposition(arr.length ? arr : Array(panelCount).fill(''));
          setPanelAspects(aspectArr.length ? aspectArr : Array(panelCount).fill('square'));
        } else {
          setComposition(Array(panelCount).fill('').map((_, i) => (i === 0 ? normalizeCompositionNotation(raw) : '')));
          setPanelAspects(Array(panelCount).fill('square'));
        }
      } catch (_) {
        setComposition(Array(panelCount).fill('').map((_, i) => (i === 0 ? normalizeCompositionNotation(raw) : '')));
        setPanelAspects(Array(panelCount).fill('square'));
      }
      setSelectedCharIds(comic.selected_characters ? comic.selected_characters.split(',').filter(Boolean) : []);
      setRefImages(comic.ref_images ? comic.ref_images.split(',').filter(Boolean) : []);
    } else {
      setTheme('');
      setEpisodeSummary('');
      setComposition(Array(panelCount).fill(''));
      setPanelAspects(Array(panelCount).fill('square'));
    }
  }, [comic, panelCount]);

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
      const res = await api.post(`/comics/${date}/suggest`, {
        theme_category: themeCategory,
        theme_region: themeRegion,
      });
      setTheme(res.data.theme || '');
      setEpisodeSummary(res.data.episode_summary || '');
    } catch (e) {
      console.error(e);
      alert('テーマ・エピソード概要の提案に失敗しました。');
    } finally {
      setIsSuggesting(false);
    }
  };

  const handleSuggestStructure = async () => {
    if (!theme.trim() && !episodeSummary.trim()) {
      alert('テーマまたはエピソード概要を入力してください。');
      return;
    }
    setIsSuggestingStructure(true);
    try {
      const res = await api.post(`/comics/${date}/suggest_structure`, {
        theme,
        episode_summary: episodeSummary
      });
      const panels = res.data.panels;
      if (Array.isArray(panels) && panels.length > 0) {
        const contents = panels
          .sort((a, b) => (a.panel || 0) - (b.panel || 0))
          .map(p => normalizeCompositionNotation(p.content != null ? String(p.content) : ''));
        const aspects = panels
          .sort((a, b) => (a.panel || 0) - (b.panel || 0))
          .map(p => {
            const a = p.aspect;
            if (a === 'landscape' || a === 'portrait' || a === 'square') return a;
            if (typeof a === 'string' && /^\d+:\d+$/.test(a)) return a;
            return 'square';
          });
        const padded = Array.from({ length: panelCount }, (_, i) => contents[i] ?? '');
        const aspectPadded = Array.from({ length: panelCount }, (_, i) => aspects[i] ?? 'square');
        setComposition(padded);
        setPanelAspects(aspectPadded);
      }
    } catch (e) {
      console.error(e);
      alert('構成の提案に失敗しました。');
    } finally {
      setIsSuggestingStructure(false);
    }
  };

  const setCompositionAt = (index, value) => {
    setComposition(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const setAspectAt = (index, value) => {
    setPanelAspects(prev => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const summaryJson = JSON.stringify(
        composition.map((content, i) => ({
          panel: i + 1,
          content: normalizeCompositionNotation(content || ''),
          aspect: panelAspects[i] || 'square'
        }))
      );
      const formData = new FormData();
      formData.append('theme', theme);
      formData.append('episode_summary', episodeSummary);
      formData.append('summary', summaryJson);
      formData.append('selected_characters', selectedCharIds.join(','));
      pendingFiles.forEach(file => {
        formData.append('ref_images', file);
      });

      // FormDataを送信する際、axiosは自動的に正しいContent-Typeを設定する
      // 手動でContent-Typeを設定するとboundaryが含まれず、サーバーがパースできなくなる可能性がある
      const res = await api.post(`/comics/${date}`, formData);
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

  const showRegionSubmenu = themeCategory === 'non_japan_events' || themeCategory === 'non_japan_trends';

  return (
    <div className="space-y-6">
      {/* テーマと構成 */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="text-xs text-stone-500 block mb-1">テーマの条件</label>
            <select
              value={themeCategory}
              onChange={(e) => setThemeCategory(e.target.value)}
              className="rounded-md border border-warm-border bg-warm-surface px-2 py-1.5 text-sm text-stone-700 shadow-warm"
            >
              {THEME_CATEGORIES.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {showRegionSubmenu && (
            <div>
              <label className="text-xs text-stone-500 block mb-1">地域</label>
              <select
                value={themeRegion}
                onChange={(e) => setThemeRegion(e.target.value)}
                className="rounded-md border border-warm-border bg-warm-surface px-2 py-1.5 text-sm text-stone-700 shadow-warm"
              >
                {THEME_REGIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold text-stone-700">テーマ</label>
          <button
            onClick={handleSuggest}
            disabled={isSuggesting}
            className="inline-flex items-center gap-1 text-xs text-amber-600 hover:text-amber-700 disabled:opacity-50 transition-colors"
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
          className="w-full rounded-lg border border-warm-border bg-warm-surface px-3 py-2 text-sm text-stone-800 placeholder-stone-400 shadow-warm"
        />

        <label className="text-sm font-semibold block text-stone-700">エピソード概要</label>
        <textarea
          value={episodeSummary}
          onChange={(e) => setEpisodeSummary(e.target.value)}
          placeholder="4コマのストーリー全体の概要（2〜4文程度）"
          className="w-full rounded-lg border border-warm-border bg-warm-surface px-3 py-2 text-sm h-20 text-stone-800 placeholder-stone-400 shadow-warm"
        />

        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold block text-stone-700">構成（コマごとの内容・セリフ・イメージ）</label>
          <button
            onClick={handleSuggestStructure}
            disabled={isSuggestingStructure || (!theme.trim() && !episodeSummary.trim())}
            className="inline-flex items-center gap-1 text-xs text-amber-600 hover:text-amber-700 disabled:opacity-50 transition-colors"
          >
            <Layout size={14} />
            {isSuggestingStructure ? '生成中...' : 'AIによる構成'}
          </button>
        </div>
        <p className="text-xs text-stone-500 mb-1">各コマの内容を記入すると、その通りに画像生成されます。空欄のコマはAIで補完されます。テーマとエピソード概要を入力して「AIによる構成」で自動生成できます。会話のあるコマは「人物配置: 右＝... 左＝... / 向き: ... / 動作: ... / セリフ: 右の...【話者：セリフ】」の厳密型テンプレートで書くと、ズレが起きにくくなります。</p>
        <div className="space-y-2">
          {Array.from({ length: panelCount }, (_, i) => (
            <div key={i}>
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs text-stone-600 block mb-0.5">{i + 1}コマ目</label>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-stone-500">比率:</span>
                  <select
                    value={['landscape', 'square', 'portrait'].includes(panelAspects[i]) ? panelAspects[i] : 'square'}
                    onChange={(e) => setAspectAt(i, e.target.value)}
                    className="rounded-md border border-warm-border bg-warm-surface px-2 py-1 text-[11px] text-stone-700 shadow-warm"
                  >
                    <option value="landscape">横長 (4:1)</option>
                    <option value="square">正方形 (1:1)</option>
                    <option value="portrait">縦長 (1:4)</option>
                  </select>
                </div>
              </div>
              <textarea
                value={composition[i] ?? ''}
                onChange={(e) => setCompositionAt(i, e.target.value)}
                placeholder={`${i + 1}コマ目の構成（例：〈構図：ロングショット〉 人物配置: 右＝子供 左＝おとな / セリフ: 右の子供【子供：もういいかーい】）`}
                className="w-full rounded-lg border border-warm-border bg-warm-surface px-3 py-2 text-sm h-16 text-stone-800 placeholder-stone-400 shadow-warm"
              />
              {/* セリフ検出プレビュー */}
              <SerifPreview content={composition[i] ?? ''} />
            </div>
          ))}
        </div>
      </div>

      {/* キャラクター選択 */}
      <div>
        <label className="text-sm font-semibold block mb-2 text-stone-700">参照キャラクター</label>
        <div className="flex flex-wrap gap-2">
          {characters.map((char) => {
            const isSelected = selectedCharIds.includes(String(char.id));
            return (
              <button
                key={char.id}
                onClick={() => toggleCharacter(char.id)}
                className={`relative rounded-lg border p-1 transition-colors shadow-warm ${
                  isSelected
                    ? 'border-amber-500 bg-amber-50'
                    : 'border-warm-border bg-warm-surface-alt hover:border-stone-400'
                }`}
              >
                {char.image_path ? (
                  <img
                    src={`/uploads/characters/${char.image_path}`}
                    alt={char.name}
                    className="w-12 h-12 object-cover rounded"
                  />
                ) : (
                  <div className="w-12 h-12 bg-warm-surface-alt rounded flex items-center justify-center text-xs text-stone-500">
                    {char.name.charAt(0)}
                  </div>
                )}
                <p className="text-[10px] mt-1 truncate max-w-[50px] text-stone-700">{char.name}</p>
                {isSelected && (
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-amber-500 flex items-center justify-center">
                    <Check size={10} className="text-white" />
                  </div>
                )}
              </button>
            );
          })}
          {characters.length === 0 && (
            <p className="text-xs text-stone-500">キャラクターが登録されていません。設定から追加してください。</p>
          )}
        </div>
      </div>

      {/* 追加参照画像 */}
      <div>
        <label className="text-sm font-semibold block mb-2 text-stone-700">追加参照画像（背景・小物など）</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {refImages.map((filename) => (
            <div key={filename} className="relative">
              <img
                src={`/uploads/comic_refs/${filename}`}
                alt={filename}
                className="w-16 h-16 object-cover rounded border border-warm-border"
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
                className="w-16 h-16 object-cover rounded border border-amber-500"
              />
              <button
                onClick={() => removePendingFile(idx)}
                className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-stone-500 text-white text-[10px] flex items-center justify-center hover:bg-stone-400"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 rounded-lg border border-warm-border bg-warm-surface-alt px-2 py-1.5 text-xs text-stone-700 hover:bg-stone-200 cursor-pointer transition-colors shadow-warm">
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
          className="rounded-lg border border-amber-600 bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-60 transition-colors"
        >
          {isSaving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
};

export default PrepareTab;
