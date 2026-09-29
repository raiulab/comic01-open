import React, { useEffect, useState, useCallback } from 'react';
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

  // 生成・出力タブを開いたときに comic を再取得し、summary を確実に最新にする（吹き出し非表示の原因を解消）
  const refetchComicForTab = useCallback(async (dateStr) => {
    if (!dateStr) return;
    try {
      const res = await api.get(`/comics/${dateStr}`);
      setCurrentComic(res.data);
    } catch (e) {
      console.error('[App] comic再取得失敗:', e);
    }
  }, []);

  useEffect(() => {
    if (selectedDate && (activeTab === 'generate' || activeTab === 'output')) {
      refetchComicForTab(selectedDate);
    }
  }, [selectedDate, activeTab, refetchComicForTab]);

  const renderTabContent = () => {
    if (!selectedDate) {
      return (
        <div className="text-center text-stone-500 py-12">
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
            onComicUpdate={handleComicUpdate}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-warm-bg">
      <header className="border-b border-warm-border bg-warm-surface shadow-warm">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-stone-800">4コマまんが制作アプリ</h1>
            <p className="text-xs text-stone-500 mt-1">
              毎日投稿する4コマ漫画の制作を支援
            </p>
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="inline-flex items-center gap-1 rounded-lg border border-warm-border bg-warm-surface-alt px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-200 transition-colors shadow-warm"
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
          <div className="flex border-b border-warm-border mb-4">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'border-b-2 border-amber-600 text-amber-700'
                    : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-warm-border bg-warm-surface p-4 shadow-warm-md">
            {renderTabContent()}
          </div>

          {currentComic && (
            <div className="mt-4 rounded-lg border border-warm-border bg-warm-surface-alt px-4 py-2.5 text-xs text-stone-600">
              <span>ステータス: </span>
              <span className={`font-medium ${
                currentComic.status === 'completed' ? 'text-amber-700' :
                currentComic.status === 'generating' ? 'text-amber-600' :
                'text-stone-700'
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
