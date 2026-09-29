import React, { useState, useMemo } from 'react';
import { RefreshCw, Paintbrush, Loader2, Undo2 } from 'lucide-react';
import api from '../api';
import PanelEditor from './PanelEditor';
import BackgroundNoteEditor from './BackgroundNoteEditor';

// プロンプトから「Nコマ目」を抽出（例: "2コマ目の表情を" → 2）。なければ 1。
const parsePanelFromPrompt = (text, panelCount) => {
  const maxPanels = Math.max(1, panelCount || 4);
  if (!text || !text.trim()) return 1;
  const m = text.match(/(\d+)\s*コマ目/);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(maxPanels, n));
};

const AdjustTab = ({ date, comic, onComicUpdate }) => {
  const [regeneratePrompt, setRegeneratePrompt] = useState('');
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);
  const [showInpaint, setShowInpaint] = useState(false);
  const [selectedStripIndex, setSelectedStripIndex] = useState(0);

  const panels = useMemo(() => comic?.panels || [], [comic?.panels]);

  // ユニークな image_path を順序保持で取得
  const imagePaths = useMemo(() => {
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
  }, [panels]);

  const selectedImagePath = imagePaths[selectedStripIndex] || imagePaths[0] || null;
  const selectedStripPanelNum = selectedImagePath
    ? (panels.find(p => p?.image_path === selectedImagePath)?.panel_number ?? 1)
    : 1;
  const panelCount = panels.length || 4;
  const hasMultipleStrips = imagePaths.length > 1;

  const handleRegenerate = async () => {
    if (!regeneratePrompt.trim()) {
      alert('修正指示を入力してください。');
      return;
    }
    const panelNum = hasMultipleStrips
      ? selectedStripPanelNum
      : parsePanelFromPrompt(regeneratePrompt, panelCount);
    setIsRegenerating(true);
    try {
      const res = await api.post(`/comics/${date}/panels/${panelNum}/regenerate`, {
        prompt: regeneratePrompt
      });
      onComicUpdate(res.data);
      setRegeneratePrompt('');
      alert('再生成が完了しました。');
    } catch (e) {
      console.error(e);
      alert(e.response?.data?.error || '再生成に失敗しました。');
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleInpaintComplete = (updatedComic) => {
    onComicUpdate(updatedComic);
    setShowInpaint(false);
  };

  const handleUndo = async (panelNum) => {
    setIsUndoing(true);
    try {
      const res = await api.post(`/comics/${date}/panels/${panelNum}/undo`);
      onComicUpdate(res.data);
      alert('元の画像に戻しました。');
    } catch (e) {
      console.error(e);
      alert(e.response?.data?.error || 'Undoに失敗しました。');
    } finally {
      setIsUndoing(false);
    }
  };

  if (panels.length === 0 || imagePaths.length === 0) {
    return (
      <div className="text-center text-stone-500 py-12">
        まだコマが生成されていません。「生成」タブから漫画を生成してください。
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 調整後の画像（セリフは画像に埋め込み済み） */}
      <div className="rounded-lg border border-warm-border bg-warm-surface-alt p-4 shadow-warm space-y-3">
        <h3 className="text-sm font-semibold text-stone-800">調整後の画像</h3>

        {/* 複数ストリップ時はどれを編集するか選択 */}
        {hasMultipleStrips && (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-xs text-stone-600">編集するストリップ:</span>
            {imagePaths.map((path, idx) => (
              <button
                key={path}
                type="button"
                onClick={() => setSelectedStripIndex(idx)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  selectedStripIndex === idx
                    ? 'bg-amber-600 text-white'
                    : 'bg-warm-surface border border-warm-border text-stone-700 hover:bg-stone-200'
                }`}
              >
                {idx + 1}枚目
              </button>
            ))}
          </div>
        )}

        {/* 画像表示（セリフは画像に埋め込まれている） */}
        <div className="space-y-4">
          {imagePaths.map((path, idx) => (
            <div key={path} className="flex flex-col items-center">
              {imagePaths.length > 1 && (
                <p className="text-xs text-stone-500 mb-1">{idx + 1}枚目</p>
              )}
              <img
                src={`/generated/${path}`}
                alt={`コマ画像 ${idx + 1}`}
                className="max-h-[70vh] w-full object-contain rounded border border-warm-border bg-white"
              />
            </div>
          ))}
        </div>

        <BackgroundNoteEditor date={date} comic={comic} onSave={onComicUpdate} />

        {!showInpaint && (
          <div className="flex flex-col gap-3">
            {hasMultipleStrips && (
              <p className="text-xs text-stone-500">
                再生成・Inpaint・Undo は「{selectedStripIndex + 1}枚目」に適用されます。
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => setShowInpaint(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-warm-border bg-warm-surface px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-200 transition-colors"
              >
                <Paintbrush size={14} />
                Inpaint（マスクで修正箇所を指定）
              </button>
              <button
                onClick={() => handleUndo(selectedStripPanelNum)}
                disabled={isUndoing}
                className="inline-flex items-center gap-1 rounded-lg border border-stone-500 bg-stone-100 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-200 disabled:opacity-60 transition-colors"
                title="再生成・Inpaint前の画像に戻す"
              >
                {isUndoing ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
                Undo（元に戻す）
              </button>
            </div>

            <p className="text-[11px] text-stone-500 leading-snug">
              ※ セリフは画像に直接埋め込まれています。セリフの内容を変更したい場合は「準備」タブで構成を編集し、再生成してください。
            </p>

            <div>
              <label className="text-xs font-medium block mb-1 text-stone-700">再生成（テキスト指示）</label>
              <textarea
                value={regeneratePrompt}
                onChange={(e) => setRegeneratePrompt(e.target.value)}
                placeholder="例: 2コマ目の表情をもっと驚いた感じにして"
                className="w-full rounded-lg border border-warm-border bg-warm-surface px-3 py-2 text-sm h-20 text-stone-800 placeholder-stone-400 shadow-warm"
              />
              <button
                onClick={() => handleRegenerate()}
                disabled={isRegenerating}
                className="mt-2 inline-flex items-center gap-1 rounded-lg border border-amber-600 bg-amber-600 px-3 py-1.5 text-xs text-white hover:bg-amber-500 disabled:opacity-60 transition-colors"
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
      </div>

      {/* Inpaintモード */}
      {showInpaint && (
        <PanelEditor
          date={date}
          imagePath={selectedImagePath}
          representativePanelNum={hasMultipleStrips ? selectedStripPanelNum : undefined}
          comic={comic}
          panels={panels}
          onComplete={handleInpaintComplete}
          onCancel={() => setShowInpaint(false)}
        />
      )}
    </div>
  );
};

export default AdjustTab;
