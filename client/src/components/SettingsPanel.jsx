import React, { useEffect, useState, useRef } from 'react';
import { Trash2, Plus, Upload, FileJson, X } from 'lucide-react';
import api from '../api';

const MAX_CHARACTERS = 21;
const MAX_STYLE_REFS = 6;

const SettingsPanel = ({ onClose }) => {
  const [activeSection, setActiveSection] = useState('basic');
  const [panelCount, setPanelCount] = useState(4);
  const [panelsPerFile, setPanelsPerFile] = useState(4);
  const [imageProvider, setImageProvider] = useState('gemini');
  const [themeProvider, setThemeProvider] = useState('gemini');
  const [outputFormat, setOutputFormat] = useState('separate');
  const [drawingStyle, setDrawingStyle] = useState('');
  const [conceptConfig, setConceptConfig] = useState('');
  const [conceptConfigError, setConceptConfigError] = useState('');
  const [imageStyleConfig, setImageStyleConfig] = useState('');
  const [imageStyleConfigError, setImageStyleConfigError] = useState('');
  const [imageStyleList, setImageStyleList] = useState([]);
  const [imageStyleSelected, setImageStyleSelected] = useState('');
  const [styleRefImages, setStyleRefImages] = useState([]);
  const [isUploadingStyleRef, setIsUploadingStyleRef] = useState(false);
  const [characters, setCharacters] = useState([]);
  const conceptFileInputRef = useRef(null);
  const imageStyleFileInputRef = useRef(null);
  const styleRefFileInputRef = useRef(null);
  const [newCharName, setNewCharName] = useState('');
  const [newCharDesc, setNewCharDesc] = useState('');
  const [newCharImage, setNewCharImage] = useState(null);
  const [newCharPreview, setNewCharPreview] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isAddingChar, setIsAddingChar] = useState(false);
  const [selectedCharacter, setSelectedCharacter] = useState(null);
  const [editCharName, setEditCharName] = useState('');
  const [editCharDesc, setEditCharDesc] = useState('');
  const [isSavingChar, setIsSavingChar] = useState(false);

  useEffect(() => {
    if (selectedCharacter) {
      setEditCharName(selectedCharacter.name || '');
      setEditCharDesc(selectedCharacter.description || '');
    }
  }, [selectedCharacter]);

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
      setPanelsPerFile(res.data.panels_per_file || 4);
      setImageProvider(res.data.image_provider === 'openai' ? 'openai' : 'gemini');
      setThemeProvider(res.data.theme_provider === 'perplexity' ? 'perplexity' : 'gemini');
      setOutputFormat(res.data.output_format === 'combined' ? 'combined' : 'separate');
      setDrawingStyle(res.data.drawing_style || '');
      setConceptConfig(res.data.concept_config || '');
      setConceptConfigError('');
      setImageStyleConfig(res.data.image_style_config || '');
      setImageStyleConfigError('');
      setImageStyleList(res.data.image_style_list || []);
      setImageStyleSelected(res.data.image_style_selected || '');
      setStyleRefImages(res.data.ref_style_image_paths || []);
    } catch (e) {
      console.error(e);
    }
  };

  const validateConceptJson = (str) => {
    if (!str || !str.trim()) return { valid: true };
    try {
      const parsed = JSON.parse(str);
      if (parsed && typeof parsed === 'object') return { valid: true, parsed };
      return { valid: false, error: '有効なJSONオブジェクトではありません。' };
    } catch (e) {
      return { valid: false, error: `JSONの形式が不正です: ${e.message}` };
    }
  };

  const handleLoadConceptSample = async () => {
    try {
      const res = await api.get('/settings/concept-example');
      setConceptConfig(JSON.stringify(res.data, null, 2));
      setConceptConfigError('');
    } catch (e) {
      console.error(e);
      setConceptConfigError(e.response?.data?.error || 'サンプルの読み込みに失敗しました。');
    }
  };

  const handleConceptFileLoad = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      const { valid, error, parsed } = validateConceptJson(text);
      if (valid) {
        setConceptConfig(parsed ? JSON.stringify(parsed, null, 2) : '');
        setConceptConfigError('');
      } else {
        setConceptConfigError(error || '読み込みに失敗しました。');
      }
    };
    reader.readAsText(file, 'UTF-8');
    e.target.value = '';
  };

  const handleConceptConfigChange = (value) => {
    setConceptConfig(value);
    if (value.trim()) {
      const { valid, error } = validateConceptJson(value);
      setConceptConfigError(valid ? '' : error);
    } else {
      setConceptConfigError('');
    }
  };

  const validateImageStyleJson = (str) => {
    if (!str || !str.trim()) return { valid: true, list: [] };
    try {
      const parsed = JSON.parse(str);
      if (!parsed || typeof parsed !== 'object') return { valid: false, error: '有効なJSONオブジェクトではありません。', list: [] };
      let list = [];
      if (Array.isArray(parsed.styles) && parsed.styles.length > 0) {
        list = parsed.styles.map((s, i) => ({ style_name: (s && s.style_name && String(s.style_name).trim()) || `スタイル${i + 1}` }));
      } else if (parsed.image_generation_prompt && typeof parsed.image_generation_prompt === 'object') {
        const s = parsed.image_generation_prompt;
        list = [{ style_name: (s.style_name && String(s.style_name).trim()) || 'スタイル1' }];
      }
      return { valid: true, list };
    } catch (e) {
      return { valid: false, error: `JSONの形式が不正です: ${e.message}`, list: [] };
    }
  };

  const handleLoadImageStyleSample = async () => {
    try {
      const res = await api.get('/settings/image-style-example');
      setImageStyleConfig(JSON.stringify(res.data, null, 2));
      const { list } = validateImageStyleJson(JSON.stringify(res.data));
      setImageStyleList(list);
      setImageStyleSelected(list[0]?.style_name || '');
      setImageStyleConfigError('');
    } catch (e) {
      console.error(e);
      setImageStyleConfigError(e.response?.data?.error || 'サンプルの読み込みに失敗しました。');
    }
  };

  const handleImageStyleFileLoad = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result;
      const { valid, error, list } = validateImageStyleJson(text);
      if (valid) {
        setImageStyleConfig(text);
        setImageStyleList(list);
        setImageStyleSelected(list[0]?.style_name || '');
        setImageStyleConfigError('');
      } else {
        setImageStyleConfigError(error || '読み込みに失敗しました。');
      }
    };
    reader.readAsText(file, 'UTF-8');
    e.target.value = '';
  };

  const handleImageStyleConfigChange = (value) => {
    setImageStyleConfig(value);
    if (value.trim()) {
      const { valid, error, list } = validateImageStyleJson(value);
      setImageStyleConfigError(valid ? '' : error);
      if (valid) {
        setImageStyleList(list);
        setImageStyleSelected((prev) => {
          const exists = list.some((item) => item.style_name === prev);
          return exists ? prev : (list[0]?.style_name || '');
        });
      }
    } else {
      setImageStyleConfigError('');
      setImageStyleList([]);
    }
  };

  const handleUploadStyleRefs = async (e) => {
    const files = e.target.files;
    if (!files?.length) return;
    const remaining = MAX_STYLE_REFS - styleRefImages.length;
    if (remaining <= 0) {
      alert(`画風参照画像は最大${MAX_STYLE_REFS}枚までです。`);
      e.target.value = '';
      return;
    }
    const formData = new FormData();
    const toAdd = Math.min(files.length, remaining);
    for (let i = 0; i < toAdd; i++) {
      formData.append('images', files[i]);
    }
    setIsUploadingStyleRef(true);
    try {
      const res = await api.post('/settings/style-refs', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      setStyleRefImages(res.data.ref_style_image_paths || []);
    } catch (err) {
      console.error(err);
      alert(err.response?.data?.error || '画風参照画像のアップロードに失敗しました。');
    } finally {
      setIsUploadingStyleRef(false);
      e.target.value = '';
    }
  };

  const handleDeleteStyleRef = async (filename) => {
    if (!confirm('この画風参照画像を削除しますか？')) return;
    try {
      const res = await api.delete(`/settings/style-refs/${encodeURIComponent(filename)}`);
      setStyleRefImages(res.data.ref_style_image_paths || []);
    } catch (err) {
      console.error(err);
      alert('削除に失敗しました。');
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
    const { valid, error } = validateConceptJson(conceptConfig);
    if (!valid) {
      setConceptConfigError(error);
      alert(`シリーズ設定のJSONが不正です。\n${error}`);
      return;
    }
    setIsSaving(true);
    try {
      await api.post('/settings', {
        panel_count: panelCount,
        panels_per_file: panelsPerFile,
        image_provider: imageProvider,
        theme_provider: themeProvider,
        output_format: outputFormat,
        drawing_style: drawingStyle,
        concept_config: conceptConfig.trim() || '',
        image_style_config: imageStyleConfig.trim() || '',
        image_style_selected: imageStyleSelected.trim() || ''
      });
      setConceptConfigError('');
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
      if (selectedCharacter?.id === id) setSelectedCharacter(null);
    } catch (e) {
      console.error(e);
      alert('削除に失敗しました。');
    }
  };

  const handleSaveCharacter = async () => {
    if (!selectedCharacter) return;
    const name = editCharName.trim();
    if (!name) {
      alert('キャラクター名を入力してください。');
      return;
    }
    setIsSavingChar(true);
    try {
      const res = await api.put(`/characters/${selectedCharacter.id}`, { name, description: editCharDesc });
      setCharacters(characters.map(c => c.id === selectedCharacter.id ? res.data : c));
      setSelectedCharacter(res.data);
      alert('保存しました。');
    } catch (e) {
      console.error(e);
      alert(e.response?.data?.error || '保存に失敗しました。');
    } finally {
      setIsSavingChar(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-stone-900/40 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-xl border border-warm-border bg-warm-surface shadow-warm-md max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-warm-border">
          <h2 className="text-sm font-semibold text-stone-800">設定</h2>
          <button onClick={onClose} className="text-xs text-stone-500 hover:text-stone-800 transition-colors">
            閉じる
          </button>
        </div>

        <div className="flex border-b border-warm-border">
          <button
            onClick={() => setActiveSection('basic')}
            className={`px-4 py-2.5 text-xs font-medium transition-colors ${
              activeSection === 'basic' ? 'border-b-2 border-amber-600 text-amber-700' : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            基本設定
          </button>
          <button
            onClick={() => setActiveSection('characters')}
            className={`px-4 py-2.5 text-xs font-medium transition-colors ${
              activeSection === 'characters' ? 'border-b-2 border-amber-600 text-amber-700' : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            キャラクター ({characters.length}/{MAX_CHARACTERS})
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 bg-warm-bg">
          {activeSection === 'basic' && (
            <div className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold mb-1 text-stone-700">コマ数（デフォルト）</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={panelCount}
                  onChange={(e) => setPanelCount(parseInt(e.target.value, 10) || 4)}
                  className="w-20 rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 shadow-warm"
                />
              </div>
              <div>
                <label className="block font-semibold mb-1 text-stone-700">1ファイルあたりのコマ数</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={panelsPerFile}
                  onChange={(e) => setPanelsPerFile(parseInt(e.target.value, 10) || 4)}
                  className="w-20 rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 shadow-warm"
                />
                <p className="mt-1 text-stone-500 text-[10px]">
                  結合出力時に1つのファイルに含めるコマ数。例: 4コマ漫画なら4。
                </p>
              </div>
              <div>
                <label className="block font-semibold mb-1 text-stone-700">画像生成API</label>
                <select
                  value={imageProvider}
                  onChange={(e) => setImageProvider(e.target.value)}
                  className="rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 shadow-warm"
                >
                  <option value="gemini">Gemini（Google）</option>
                  <option value="openai">OpenAI（DALL-E 3）</option>
                </select>
                <p className="mt-1 text-stone-500 text-[10px]">
                  OpenAI 利用時は環境変数 OPENAI_API_KEY を設定してください。Inpaint（部分修正）は Gemini のみ対応。
                </p>
              </div>
              <div>
                <label className="block font-semibold mb-1 text-stone-700">テーマ提案のAI</label>
                <select
                  value={themeProvider}
                  onChange={(e) => setThemeProvider(e.target.value)}
                  className="rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 shadow-warm"
                >
                  <option value="gemini">Gemini（Google）</option>
                  <option value="perplexity">Perplexity（リアルタイム検索）</option>
                </select>
                <p className="mt-1 text-stone-500 text-[10px]">
                  Perplexity 利用時は環境変数 PERPLEXITY_API_KEY を設定してください。その日のニュース・出来事を検索して提案します。
                </p>
              </div>
              <div>
                <label className="block font-semibold mb-1 text-stone-700">画像の出力形式</label>
                <select
                  value={outputFormat}
                  onChange={(e) => setOutputFormat(e.target.value)}
                  className="rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 shadow-warm"
                >
                  <option value="separate">コマ別（複数枚）</option>
                  <option value="combined">1枚に結合</option>
                </select>
                <p className="mt-1 text-stone-500 text-[10px]">
                  コマ別: 各コマを個別ファイルで出力。1枚に結合: 生成後に1枚の画像としても保存・ダウンロード可能。
                </p>
              </div>
              <div>
                <label className="block font-semibold mb-1 text-stone-700">画風参照画像</label>
                <p className="text-stone-500 text-[10px] mb-1">生成される漫画の画風の参考として使います。最大{MAX_STYLE_REFS}枚。</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  {styleRefImages.map((filename) => (
                    <div key={filename} className="relative rounded-lg border border-warm-border bg-warm-surface overflow-hidden group">
                      <img
                        src={`/uploads/style_refs/${filename}`}
                        alt="画風参照"
                        className="w-16 h-16 object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => handleDeleteStyleRef(filename)}
                        className="absolute top-0.5 right-0.5 p-1 rounded bg-red-600 hover:bg-red-500 text-white opacity-90"
                      >
                        <Trash2 size={10} />
                      </button>
                    </div>
                  ))}
                  {styleRefImages.length < MAX_STYLE_REFS && (
                    <label className="w-16 h-16 rounded-lg border border-dashed border-warm-border bg-warm-surface-alt flex items-center justify-center cursor-pointer hover:bg-stone-200 transition-colors">
                      <input
                        ref={styleRefFileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={handleUploadStyleRefs}
                        className="hidden"
                      />
                      {isUploadingStyleRef ? (
                        <span className="text-stone-400 text-[10px]">送信中...</span>
                      ) : (
                        <Plus size={20} className="text-stone-400" />
                      )}
                    </label>
                  )}
                </div>
              </div>
              <div>
                <label className="block font-semibold mb-1 text-stone-700">画風設定（シリーズ設定に art_style がない場合のフォールバック）</label>
                <textarea
                  value={drawingStyle}
                  onChange={(e) => setDrawingStyle(e.target.value)}
                  placeholder="例: 白背景、黒のマジックペンで描かれたラフなイラスト漫画スタイル"
                  className="w-full rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 h-16 text-stone-800 placeholder-stone-400 shadow-warm"
                />
              </div>
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block font-semibold text-stone-700 flex items-center gap-1">
                    <FileJson size={14} />
                    画風設定（画像生成用JSON）
                  </label>
                  <input
                    ref={imageStyleFileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleImageStyleFileLoad}
                    className="hidden"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={handleLoadImageStyleSample}
                      className="inline-flex items-center gap-1 rounded-lg border border-warm-border bg-warm-surface-alt px-2 py-1.5 text-stone-600 hover:bg-stone-200 transition-colors"
                    >
                      <FileJson size={12} />
                      サンプルを読み込み
                    </button>
                    <button
                      type="button"
                      onClick={() => imageStyleFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 rounded-lg border border-warm-border bg-warm-surface-alt px-2 py-1.5 text-stone-600 hover:bg-stone-200 transition-colors"
                    >
                      <Upload size={12} />
                      ファイルを読み込み
                    </button>
                  </div>
                </div>
                {imageStyleList.length > 1 && (
                  <div className="mb-2">
                    <label className="block text-stone-500 text-[11px] mb-1">使用するスタイル</label>
                    <select
                      value={imageStyleSelected}
                      onChange={(e) => setImageStyleSelected(e.target.value)}
                      className="rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 shadow-warm text-xs"
                    >
                      {imageStyleList.map((item) => (
                        <option key={item.style_name} value={item.style_name}>
                          {item.style_name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <textarea
                  value={imageStyleConfig}
                  onChange={(e) => handleImageStyleConfigChange(e.target.value)}
                  placeholder='{"image_generation_prompt":{"style_name":"...","core_concept":"...","attributes":{...}}} または {"styles":[{...},{...}]}'
                  className={`w-full rounded-lg border px-2 py-1.5 min-h-[120px] text-stone-800 placeholder-stone-400 shadow-warm font-mono text-[11px] ${
                    imageStyleConfigError ? 'border-red-500 bg-red-50' : 'border-warm-border bg-warm-surface'
                  }`}
                  spellCheck={false}
                />
                {imageStyleConfigError && (
                  <p className="mt-1 text-red-600 text-[11px]">{imageStyleConfigError}</p>
                )}
                <p className="mt-1 text-stone-500 text-[10px]">
                  画像生成時に使う画風をJSONで指定します。
                  <br />
                  <strong>スタイルが1種類だけ</strong>のときは、ルートに <code className="bg-stone-200 px-0.5 rounded">image_generation_prompt</code> というキーで1つだけオブジェクトを書きます。
                  <strong>2種類以上</strong>のときは、ルートに <code className="bg-stone-200 px-0.5 rounded">styles</code> というキーで配列を書き、中にスタイルごとのオブジェクト（それぞれ <code className="bg-stone-200 px-0.5 rounded">style_name</code> 必須）を並べます。複数ある場合は上のドロップダウンでどれを使うか選べます。サンプル: config/image-style.example.json
                </p>
              </div>
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="block font-semibold text-stone-700 flex items-center gap-1">
                    <FileJson size={14} />
                    シリーズ設定（JSON）
                  </label>
                  <input
                    ref={conceptFileInputRef}
                    type="file"
                    accept=".json,application/json"
                    onChange={handleConceptFileLoad}
                    className="hidden"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={handleLoadConceptSample}
                      className="inline-flex items-center gap-1 rounded-lg border border-warm-border bg-warm-surface-alt px-2 py-1.5 text-stone-600 hover:bg-stone-200 transition-colors"
                    >
                      <FileJson size={12} />
                      サンプルを読み込み
                    </button>
                    <button
                      type="button"
                      onClick={() => conceptFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 rounded-lg border border-warm-border bg-warm-surface-alt px-2 py-1.5 text-stone-600 hover:bg-stone-200 transition-colors"
                    >
                      <Upload size={12} />
                      ファイルを読み込み
                    </button>
                  </div>
                </div>
                <textarea
                  value={conceptConfig}
                  onChange={(e) => handleConceptConfigChange(e.target.value)}
                  placeholder='{"main_character":{"description":"...","speaks":false},"art_style":"...", ...}'
                  className={`w-full rounded-lg border px-2 py-1.5 min-h-[140px] text-stone-800 placeholder-stone-400 shadow-warm font-mono text-[11px] ${
                    conceptConfigError ? 'border-red-500 bg-red-50' : 'border-warm-border bg-warm-surface'
                  }`}
                  spellCheck={false}
                />
                {conceptConfigError && (
                  <p className="mt-1 text-red-600 text-[11px]">{conceptConfigError}</p>
                )}
                <p className="mt-1 text-stone-500 text-[10px]">
                  主役・トーン・画風・色・配信方針などをJSONで指定。空欄の場合は画風設定のみ使用。サンプル: config/series-concept.example.json
                </p>
              </div>
              <button
                onClick={handleSaveSettings}
                disabled={isSaving || !!conceptConfigError || !!imageStyleConfigError}
                className="rounded-lg border border-amber-600 bg-amber-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-60 transition-colors"
              >
                {isSaving ? '保存中...' : '保存'}
              </button>
            </div>
          )}

          {activeSection === 'characters' && (
            <div className="space-y-4 text-xs">
              {/* キャラクター詳細モーダル */}
              {selectedCharacter && (
                <div className="fixed inset-0 bg-stone-900/50 flex items-center justify-center z-[60]" onClick={() => setSelectedCharacter(null)}>
                  <div
                    className="bg-warm-surface rounded-xl border border-warm-border shadow-warm-md max-w-md w-full mx-4 max-h-[85vh] overflow-hidden flex flex-col"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-between p-4 border-b border-warm-border">
                      <h3 className="font-semibold text-stone-800">キャラクター詳細</h3>
                      <button onClick={() => setSelectedCharacter(null)} className="p-1 rounded hover:bg-stone-200 text-stone-600">
                        <X size={18} />
                      </button>
                    </div>
                    <div className="p-4 overflow-y-auto space-y-4">
                      {selectedCharacter.image_path ? (
                        <img
                          src={`/uploads/characters/${selectedCharacter.image_path}`}
                          alt={selectedCharacter.name}
                          className="w-full max-h-48 object-contain rounded-lg border border-warm-border bg-warm-surface-alt"
                        />
                      ) : (
                        <div className="w-full h-32 bg-warm-surface-alt rounded-lg border border-warm-border flex items-center justify-center text-stone-400">
                          画像なし
                        </div>
                      )}
                      <div>
                        <label className="block text-stone-500 text-[11px] mb-1">キャラクター名</label>
                        <input
                          type="text"
                          value={editCharName}
                          onChange={(e) => setEditCharName(e.target.value)}
                          className="w-full rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800"
                        />
                      </div>
                      <div>
                        <label className="block text-stone-500 text-[11px] mb-1">属性</label>
                        <textarea
                          value={editCharDesc}
                          onChange={(e) => setEditCharDesc(e.target.value)}
                          rows={5}
                          className="w-full rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 min-h-[100px] resize-y"
                        />
                      </div>
                      <div className="flex justify-end gap-2 pt-2">
                        <button
                          type="button"
                          onClick={() => setSelectedCharacter(null)}
                          className="rounded-lg border border-warm-border px-3 py-1.5 text-stone-700 hover:bg-stone-100"
                        >
                          閉じる
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveCharacter}
                          disabled={isSavingChar}
                          className="rounded-lg border border-amber-600 bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-500 disabled:opacity-60"
                        >
                          {isSavingChar ? '保存中...' : '保存'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                {characters.map((char) => (
                  <div
                    key={char.id}
                    className="relative rounded-lg border border-warm-border bg-warm-surface p-2 shadow-warm cursor-pointer hover:border-amber-500/50 transition-colors"
                    onClick={() => setSelectedCharacter(char)}
                  >
                    {char.image_path ? (
                      <img
                        src={`/uploads/characters/${char.image_path}`}
                        alt={char.name}
                        className="w-full h-20 object-cover rounded mb-2"
                      />
                    ) : (
                      <div className="w-full h-20 bg-warm-surface-alt rounded mb-2 flex items-center justify-center text-stone-400">
                        No Image
                      </div>
                    )}
                    <p className="font-semibold truncate text-stone-800">{char.name}</p>
                    {char.description && (
                      <p className="text-stone-500 truncate">{char.description}</p>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteCharacter(char.id); }}
                      className="absolute top-1 right-1 p-1 rounded bg-red-600 hover:bg-red-500 text-white"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>

              {characters.length < MAX_CHARACTERS && (
                <div className="border border-warm-border rounded-lg p-3 space-y-2 bg-warm-surface shadow-warm">
                  <p className="font-semibold text-stone-700">キャラクター追加</p>
                  <input
                    type="text"
                    value={newCharName}
                    onChange={(e) => setNewCharName(e.target.value)}
                    placeholder="キャラクター名"
                    className="w-full rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 placeholder-stone-400"
                  />
                  <div>
                    <label className="block text-stone-600 mb-1">属性</label>
                    <textarea
                      value={newCharDesc}
                      onChange={(e) => setNewCharDesc(e.target.value)}
                      placeholder="属性（任意）"
                      rows={5}
                      className="w-full rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 placeholder-stone-400 min-h-[120px] resize-y"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-1 rounded-lg border border-warm-border bg-warm-surface-alt px-2 py-1.5 hover:bg-stone-200 cursor-pointer text-stone-700 transition-colors">
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
                    className="rounded-lg border border-amber-600 bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-500 disabled:opacity-60 transition-colors"
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
