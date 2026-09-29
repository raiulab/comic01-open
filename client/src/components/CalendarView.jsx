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

  // 日付単位の状態判定
  const getDayStatus = (date) => {
    const dateStr = formatDate(date);
    const comic = comics.find((c) => c.date === dateStr);
    if (!comic) return { hasImage: false, hasTextOnly: false, isGenerating: false };
    const hasImage = comic.status === 'completed';
    const isGenerating = comic.status === 'generating';
    const hasTextOnly = comic.status === 'draft' && (comic.theme || comic.summary);
    return { hasImage, hasTextOnly, isGenerating };
  };

  // 月単位の状態判定（その月に1日でもテキストのみ or 画像ありがあればフラグを立てる）
  const getMonthStatus = (year, month) => {
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    let hasImage = false;
    let hasTextOnly = false;
    for (const c of comics) {
      if (!c.date || !c.date.startsWith(ym)) continue;
      if (c.status === 'completed') {
        hasImage = true;
      } else if (c.status === 'draft' && (c.theme || c.summary)) {
        hasTextOnly = true;
      }
      if (hasImage && hasTextOnly) break;
    }
    return { hasImage, hasTextOnly };
  };

  // 年単位の状態判定
  const getYearStatus = (year) => {
    const ys = `${year}-`;
    let hasImage = false;
    let hasTextOnly = false;
    for (const c of comics) {
      if (!c.date || !c.date.startsWith(ys)) continue;
      if (c.status === 'completed') {
        hasImage = true;
      } else if (c.status === 'draft' && (c.theme || c.summary)) {
        hasTextOnly = true;
      }
      if (hasImage && hasTextOnly) break;
    }
    return { hasImage, hasTextOnly };
  };

  // 10年単位（decade） の状態判定: startYear 〜 startYear+9 の範囲に1件でもあれば色付け
  const getDecadeStatus = (startYear) => {
    let hasImage = false;
    let hasTextOnly = false;
    for (const c of comics) {
      if (!c.date) continue;
      const y = parseInt(c.date.slice(0, 4), 10);
      if (Number.isNaN(y)) continue;
      if (y < startYear || y > startYear + 9) continue;
      if (c.status === 'completed') {
        hasImage = true;
      } else if (c.status === 'draft' && (c.theme || c.summary)) {
        hasTextOnly = true;
      }
      if (hasImage && hasTextOnly) break;
    }
    return { hasImage, hasTextOnly };
  };

  const getTileClass = ({ date, view }) => {
    if (view === 'month') {
      // 日タイル
      const { hasImage, hasTextOnly, isGenerating } = getDayStatus(date);
      if (hasImage) return '!bg-blue-500 text-white rounded-full'; // 画像まで生成してある日 → 青
      if (isGenerating) return '!bg-amber-500 text-white rounded-full'; // 生成中
      if (hasTextOnly) return '!bg-green-500 text-white rounded-full'; // 準備タブで文章のみ記入 → 緑
      return '';
    }
    if (view === 'year') {
      // 月タイル（1年分の各月）
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      const { hasImage, hasTextOnly } = getMonthStatus(year, month);
      if (hasImage) return '!bg-blue-100 text-blue-700 rounded-lg'; // その月に画像まで生成してある日がある → 青系
      if (hasTextOnly) return '!bg-green-100 text-green-700 rounded-lg'; // その月に文章のみの日がある → 緑系
      return '';
    }
    if (view === 'decade') {
      // 年タイル（10年分の各年）
      const year = date.getFullYear();
      const { hasImage, hasTextOnly } = getYearStatus(year);
      if (hasImage) return '!bg-blue-100 text-blue-700 rounded-lg';
      if (hasTextOnly) return '!bg-green-100 text-green-700 rounded-lg';
      return '';
    }
    if (view === 'century') {
      // 10年単位のタイル（各タイルが1つのdecade=10年）
      const startYear = date.getFullYear(); // React-Calendar では decade の開始年が渡される
      const { hasImage, hasTextOnly } = getDecadeStatus(startYear);
      if (hasImage) return '!bg-blue-100 text-blue-700 rounded-lg';
      if (hasTextOnly) return '!bg-green-100 text-green-700 rounded-lg';
      return '';
    }
    return '';
  };

  /** 「2026年2月」を「2026年」と「2月」の間でのみ改行可能にしつつ、年・月に状態に応じた色を付ける */
  const navigationLabel = ({ date, label }) => {
    const str = typeof label === 'string' ? label : `${date.getFullYear()}年${date.getMonth() + 1}月`;
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const yearStatus = getYearStatus(year);
    const monthStatus = getMonthStatus(year, month);

    const yearClass = yearStatus.hasImage
      ? 'text-blue-600 font-semibold'
      : yearStatus.hasTextOnly
      ? 'text-green-600 font-semibold'
      : '';
    const monthClass = monthStatus.hasImage
      ? 'text-blue-600 font-semibold'
      : monthStatus.hasTextOnly
      ? 'text-green-600 font-semibold'
      : '';

    const match = str.match(/^(.+年)(.+)$/);
    if (match) {
      return (
        <span className="react-calendar-nav-label">
          <span className={yearClass}>{match[1]}</span>
          <wbr />
          <span className={monthClass}>{match[2]}</span>
        </span>
      );
    }
    return (
      <span className="react-calendar-nav-label">
        <span className={yearClass || monthClass}>{str}</span>
      </span>
    );
  };

  return (
    <div className="rounded-xl border border-warm-border bg-warm-surface p-3 shadow-warm-md">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-semibold text-stone-800">カレンダー</h2>
      </div>
      <Calendar
        locale="ja-JP"
        onChange={handleChange}
        value={value}
        tileClassName={getTileClass}
        formatDay={(locale, date) => date.getDate().toString()}
        navigationLabel={navigationLabel}
        className="w-full border-0 rounded-lg [&_.react-calendar__tile]:py-1"
      />
      <div className="mt-3 text-[10px] text-stone-500 space-y-1">
        <p>● 緑: 準備タブで文章のみ記入してある日（テーマ・構成などテキストのみ）</p>
        <p>● 青: 画像まで生成してある日（完成済み）</p>
        <p>● オレンジ: 画像生成中</p>
      </div>
    </div>
  );
};

export default CalendarView;
