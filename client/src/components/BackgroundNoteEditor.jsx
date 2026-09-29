import React, { useState, useEffect } from 'react';
import { Save, Loader2 } from 'lucide-react';
import api from '../api';

const MAX_LENGTH = 140;

/** date (YYYY-MM-DD) から「○年○月○日」のラベル用文字列を返す */
function formatDateLabel(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '○年○月○日';
  const parts = dateStr.trim().split('-').map(Number);
  if (parts.length < 3) return '○年○月○日';
  const [year, month, day] = parts;
  if (!year || !month || !day) return '○年○月○日';
  return `${year}年${month}月${day}日`;
}

/**
 * まんが画像の下に表示する「○月○日の出来事メモ」の編集欄。
 * 指定日付の出来事・豆知識などを140文字以内で表示・手書き編集・保存する。
 */
const BackgroundNoteEditor = ({ date, comic, onSave }) => {
  const [value, setValue] = useState(comic?.background_note ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const dateLabel = formatDateLabel(date);

  useEffect(() => {
    setValue(comic?.background_note ?? '');
  }, [comic?.background_note, date]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await api.patch(`/comics/${date}/background`, {
        background_note: value.slice(0, MAX_LENGTH).trim()
      });
      if (onSave) onSave(res.data);
    } catch (e) {
      console.error(e);
      alert(e.response?.data?.error || '保存に失敗しました。');
    } finally {
      setIsSaving(false);
    }
  };

  const count = value.length;

  return (
    <div className="rounded-lg border border-warm-border bg-warm-surface p-4 shadow-warm mt-4">
      <label className="block text-sm font-semibold text-stone-800 mb-2">
        {dateLabel}の出来事メモ
      </label>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, MAX_LENGTH))}
        maxLength={MAX_LENGTH}
        rows={5}
        placeholder="この日の出来事や豆知識を読者に知らせる説明を書けます。"
        className="w-full rounded-lg border border-warm-border bg-white px-3 py-2 text-sm text-stone-800 placeholder-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500/50 resize-y"
      />
      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-stone-500">
          {count}/{MAX_LENGTH}文字
        </span>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-600 bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {isSaving ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Save size={14} />
          )}
          {isSaving ? '保存中...' : '保存'}
        </button>
      </div>
    </div>
  );
};

export default BackgroundNoteEditor;
