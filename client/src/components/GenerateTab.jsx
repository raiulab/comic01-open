import React, { useState, useEffect } from 'react';
import { Play, Loader2, Download } from 'lucide-react';
import api from '../api';
import BackgroundNoteEditor from './BackgroundNoteEditor';

const GenerateTab = ({ date, comic, onComicUpdate }) => {
  const [panelCount, setPanelCount] = useState(4);
  const [outputFormat, setOutputFormat] = useState('separate');
  const [imageStyleSelected, setImageStyleSelected] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [lastCombinedPath, setLastCombinedPath] = useState(null);
  const [displayUrls, setDisplayUrls] = useState([]);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const res = await api.get('/settings');
      setPanelCount(res.data.panel_count || 4);
      setOutputFormat(res.data.output_format === 'combined' ? 'combined' : 'separate');
      setImageStyleSelected(res.data.image_style_selected || '');
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
    setProgress({ current: 0, total: 1 });
    setLastCombinedPath(null);

    try {
      await api.post(`/comics/${date}`, { status: 'generating' });

      const res = await api.post(`/comics/${date}/generate`, {
        panel_count: panelCount,
        output_format: outputFormat
      });

      onComicUpdate(res.data);
      if (res.data.combined_image_path) {
        setLastCombinedPath(res.data.combined_image_path);
      }
      alert('漫画の生成が完了しました！');
    } catch (e) {
      console.error(e);
      const msg = e.response?.data?.error || '生成に失敗しました。';
      const details = e.response?.data?.details;
      alert(details && details !== msg ? `${msg}\n\n詳細: ${details}` : msg);
    } finally {
      setIsGenerating(false);
      setProgress({ current: 0, total: 0 });
    }
  };

  const panels = comic?.panels || [];
  const generatedCount = panels.filter(p => p.status !== 'ungenerated').length;

  // 表示用: 結合1枚 or パネルごとのユニークな image_path（順序保持）
  const displayImagePaths = lastCombinedPath
    ? [lastCombinedPath]
    : (() => {
        const seen = new Set();
        return panels
          .filter(p => p?.image_path)
          .reduce((acc, p) => {
            if (!seen.has(p.image_path)) {
              seen.add(p.image_path);
              acc.push(p.image_path);
            }
            return acc;
          }, []);
      })();

  // 提案B: セリフは画像に最初から描き込まれるため、オーバーレイせずそのまま表示
  useEffect(() => {
    if (displayImagePaths.length > 0) {
      setDisplayUrls(displayImagePaths.map((p) => `/generated/${p}`));
    } else {
      setDisplayUrls([]);
    }
  }, [displayImagePaths.join(',')]);

  return (
    <div className="space-y-6">
      {/* 生成設定 */}
      <div className="rounded-lg border border-warm-border bg-warm-surface-alt p-4 shadow-warm">
        <h3 className="text-sm font-semibold mb-3 text-stone-800">生成設定</h3>
        <div className="flex flex-wrap items-center gap-4 text-sm text-stone-700">
          <div className="flex items-center gap-2">
            <label>コマ数:</label>
            <input
              type="number"
              min="1"
              max="10"
              value={panelCount}
              onChange={(e) => setPanelCount(parseInt(e.target.value, 10) || 4)}
              disabled={isGenerating}
              className="w-16 rounded-lg border border-warm-border bg-warm-surface px-2 py-1.5 text-stone-800 shadow-warm"
            />
          </div>
          <div className="flex items-center gap-2">
            <label>出力形式:</label>
            <span className="text-stone-600">
              {outputFormat === 'combined' ? '1枚に結合' : 'コマ別（複数枚）'}
            </span>
            <span className="text-xs text-stone-500">（設定で変更）</span>
          </div>
        </div>
      </div>

      {/* 現在の状態 */}
      <div className="rounded-lg border border-warm-border bg-warm-surface-alt p-4 shadow-warm">
        <h3 className="text-sm font-semibold mb-3 text-stone-800">現在の状態</h3>
        <div className="text-sm space-y-2 text-stone-700">
          <p>テーマ: {comic?.theme || <span className="text-stone-500">未設定</span>}</p>
          <p>構成: {comic?.summary ? <span>設定済み</span> : <span className="text-stone-500">未設定</span>}</p>
          <p>生成済みコマ: {generatedCount} / {panels.length || panelCount}</p>
        </div>
      </div>

      {/* プログレス表示 */}
      {isGenerating && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 size={16} className="animate-spin text-amber-600" />
            <span className="text-sm font-medium text-amber-700">生成中...</span>
          </div>
          <div className="w-full bg-stone-200 rounded-full h-2">
            <div
              className="bg-amber-500 h-2 rounded-full transition-all"
              style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }}
            />
          </div>
          <p className="text-xs text-stone-500 mt-1">
            {progress.current} / {progress.total} コマ完了
          </p>
        </div>
      )}

      {/* 生成ボタン */}
      <div className="flex justify-center">
        <button
          onClick={handleGenerate}
          disabled={isGenerating || !comic?.theme}
          className="inline-flex items-center gap-2 rounded-lg border border-amber-600 bg-amber-600 px-6 py-3 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
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

      {/* 生成後の画像表示（提案B: セリフは画像に描き込み済みのためそのまま表示） */}
      {displayUrls.length > 0 && (
        <div className="rounded-lg border border-warm-border bg-warm-surface-alt p-4 shadow-warm">
          <h3 className="text-sm font-semibold mb-3 text-stone-800">生成画像（セリフ込み）</h3>
          {imageStyleSelected && (
            <p className="text-xs text-stone-500 mb-3">画風: {imageStyleSelected}</p>
          )}
          <div className="space-y-4">
            {displayUrls.map((url, idx) => (
              <div key={idx} className="flex flex-col items-center">
                {displayUrls.length > 1 && (
                  <p className="text-xs text-stone-500 mb-1">{idx + 1}枚目</p>
                )}
                <img
                  src={url}
                  alt={displayUrls.length > 1 ? `生成した漫画 ${idx + 1}枚目` : '生成した漫画'}
                  className="max-h-[70vh] w-full object-contain rounded border border-warm-border bg-white"
                />
                <a
                  href={url.startsWith('http') ? url : (window.location.origin + url)}
                  download={`comic-${date}-${idx + 1}.png`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-2 rounded-lg border border-amber-600 bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 transition-colors"
                >
                  <Download size={16} />
                  {displayUrls.length > 1 ? `画像${idx + 1}をダウンロード` : '画像をダウンロード'}
                </a>
              </div>
            ))}
          </div>
          <BackgroundNoteEditor date={date} comic={comic} onSave={onComicUpdate} />
        </div>
      )}

      {!comic?.theme && (
        <p className="text-center text-xs text-amber-700/90">
          ※ 先に「準備」タブでテーマと構成を設定してください
        </p>
      )}
    </div>
  );
};

export default GenerateTab;
