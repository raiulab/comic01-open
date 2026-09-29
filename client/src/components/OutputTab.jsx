import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Save, Loader2, Download, FolderOpen } from 'lucide-react';
import api from '../api';
import BackgroundNoteEditor from './BackgroundNoteEditor';

// ファイル名生成のヘルパー関数（サーバーと同じ命名規則: 常に連番付き）
const generateFileName = (date, index) => {
  return `comic-${date}-${index + 1}.png`;
};

const OutputTab = ({ date, comic, onComicUpdate }) => {
  const [isSaving, setIsSaving] = useState(false);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [panelsPerFile, setPanelsPerFile] = useState(4);
  const saveMenuRef = useRef(null);

  const panels = comic?.panels || [];
  const generatedPanels = panels.filter(p => p.image_path);

  // 設定からpanels_per_fileを取得
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const res = await api.get('/settings');
        setPanelsPerFile(res.data.panels_per_file || 4);
      } catch (e) {
        console.error('設定の読み込みに失敗しました:', e);
      }
    };
    loadSettings();
  }, []);

  // パネルをグループに分割する関数（panel_numberでソート）
  const splitPanels = (panels, perFile) => {
    const sortedPanels = [...panels].sort((a, b) => Number(a.panel_number) - Number(b.panel_number));
    const groups = [];
    for (let i = 0; i < sortedPanels.length; i += perFile) {
      groups.push(sortedPanels.slice(i, i + perFile));
    }
    return groups;
  };

  // ユニークな画像パスを取得
  const imagePaths = useMemo(() => {
    const seen = new Set();
    return generatedPanels
      .sort((a, b) => Number(a.panel_number) - Number(b.panel_number))
      .reduce((acc, p) => {
        if (p.image_path && !seen.has(p.image_path)) {
          seen.add(p.image_path);
          acc.push(p.image_path);
        }
        return acc;
      }, []);
  }, [generatedPanels]);

  // 保存メニューを閉じるハンドラ
  useEffect(() => {
    const close = (e) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target)) setShowSaveMenu(false);
    };
    if (showSaveMenu) {
      document.addEventListener('click', close);
      return () => document.removeEventListener('click', close);
    }
  }, [showSaveMenu]);

  // 個別グループのダウンロード
  const handleDownloadGroup = async (index) => {
    const path = imagePaths[index];
    if (!path) return;
    const link = document.createElement('a');
    link.download = generateFileName(date, index);
    link.href = `/generated/${path}`;
    link.click();
  };

  // 全グループを一括ダウンロード（ブラウザ）
  const handleDownloadAll = () => {
    imagePaths.forEach((_, index) => {
      setTimeout(() => handleDownloadGroup(index), index * 200);
    });
    setShowSaveMenu(false);
  };

  // サーバーに保存（複数画像を一括送信）
  const handleSaveToServer = async () => {
    if (imagePaths.length === 0) return;
    setShowSaveMenu(false);
    setIsSaving(true);
    try {
      const formData = new FormData();

      // 全画像をFormDataに追加
      for (let i = 0; i < imagePaths.length; i++) {
        const path = imagePaths[i];
        const res = await fetch(`/generated/${path}`);
        const blob = await res.blob();
        const fileName = generateFileName(date, i);
        formData.append('images', blob, fileName);
      }

      // 一括送信
      await api.post(`/comics/${date}/save`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      alert(`出力フォルダに${imagePaths.length}枚保存しました。`);
    } catch (e) {
      const errorMessage = e.response?.data?.error || e.message || '保存に失敗しました。';
      console.error('保存エラー詳細:', e);
      alert(errorMessage);
    } finally {
      setIsSaving(false);
    }
  };

  if (generatedPanels.length === 0) {
    return (
      <div className="text-center text-stone-500 py-12">
        まだコマが生成されていません。「生成」タブから漫画を生成してください。
      </div>
    );
  }

  const totalGroups = imagePaths.length;

  return (
    <div className="space-y-6">
      {/* グループごとのプレビュー（セリフは画像に埋め込み済み） */}
      {imagePaths.map((path, index) => (
        <div key={path} className="rounded-lg border border-warm-border bg-warm-surface-alt p-4 shadow-warm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-stone-800">
              出力画像 {totalGroups > 1 ? `(${index + 1}/${totalGroups})` : ''}
            </h3>
            <button
              onClick={() => handleDownloadGroup(index)}
              className="inline-flex items-center gap-1 rounded-lg border border-warm-border bg-warm-surface px-3 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-200 transition-colors"
            >
              <Download size={14} />
              ダウンロード {totalGroups > 1 ? `(${index + 1}/${totalGroups})` : ''}
            </button>
          </div>

          <p className="text-xs text-stone-500 mb-2">
            セリフは画像に直接埋め込まれています。
          </p>

          <div className="flex justify-center">
            <img
              src={`/generated/${path}`}
              alt={`出力画像 ${index + 1}`}
              className="max-h-[60vh] object-contain rounded border border-warm-border bg-white"
            />
          </div>
          {index === 0 && (
            <BackgroundNoteEditor date={date} comic={comic} onSave={onComicUpdate} />
          )}
        </div>
      ))}

      {/* 保存（保存先を選択） */}
      {imagePaths.length > 0 && (
        <div className="flex justify-center">
          <div className="relative" ref={saveMenuRef}>
            <button
              onClick={() => setShowSaveMenu(!showSaveMenu)}
              disabled={isSaving}
              className="inline-flex items-center gap-2 rounded-lg border border-amber-600 bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-60 transition-colors"
            >
              {isSaving ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Save size={16} />
              )}
              {isSaving ? '保存中...' : '保存'}
            </button>
            {showSaveMenu && !isSaving && (
              <div className="absolute top-full left-0 mt-1 py-1 rounded-lg border border-warm-border bg-warm-surface shadow-warm min-w-[200px] z-10">
                <button
                  onClick={handleDownloadAll}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-stone-700 hover:bg-warm-surface-alt transition-colors text-left"
                >
                  <Download size={16} />
                  {totalGroups > 1 ? `全てダウンロード（${totalGroups}ファイル）` : 'ダウンロード（ブラウザ）'}
                </button>
                <button
                  onClick={handleSaveToServer}
                  className="w-full flex items-center gap-2 px-4 py-2 text-sm text-stone-700 hover:bg-warm-surface-alt transition-colors text-left"
                >
                  <FolderOpen size={16} />
                  出力フォルダに保存
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default OutputTab;
