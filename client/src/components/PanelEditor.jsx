import React, { useRef, useState, useEffect } from 'react';
import { Eraser, Paintbrush, Send, X, Loader2 } from 'lucide-react';
import api from '../api';

const PanelEditor = ({ date, imagePath, representativePanelNum, comic, panels, onComplete, onCancel }) => {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(20);
  const [tool, setTool] = useState('brush');
  const [prompt, setPrompt] = useState('');
  const [inpaintMode, setInpaintMode] = useState('serif');
  const [overlayVertical, setOverlayVertical] = useState(true);
  const [overlayFontScale, setOverlayFontScale] = useState(1.2);
  const [maskMargin, setMaskMargin] = useState(0);
  const [edgeFeather, setEdgeFeather] = useState(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imgElement, setImgElement] = useState(null);

  // モード切り替え時にマスクマージンのデフォルトを反映（イラスト0、セリフ・オーバーレイ8）
  useEffect(() => {
    setMaskMargin(inpaintMode === 'illustration' ? 0 : 8);
  }, [inpaintMode]);

  // 画像を読み込んでキャンバスを設定（マスクと元画像のピクセル一致を保証）
  useEffect(() => {
    if (!imagePath) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setImgElement(img);
      setImageLoaded(true);
    };
    img.onerror = () => {
      console.error('[PanelEditor] 画像読み込みエラー:', imagePath);
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
      // 不透明な赤で描画（半透明だとマスク検出・二値化でエッジのノイズや検出漏れが起きる）
      ctx.fillStyle = '#ff0000';
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
      const body = { mask: maskDataUrl, prompt: prompt.trim(), inpaint_mode: inpaintMode };
      if (representativePanelNum != null) body.panel_num = representativePanelNum;
      if (inpaintMode === 'overlay') {
        body.overlay_vertical = overlayVertical;
        body.overlay_font_scale = overlayFontScale;
      }
      body.mask_margin = Math.max(0, Math.min(20, maskMargin));
      body.edge_feather = Math.max(0, Math.min(8, edgeFeather));
      const res = await api.post(`/comics/${date}/inpaint`, body);
      onComplete(res.data);
    } catch (e) {
      console.error(e);
      const msg = e.code === 'ECONNABORTED' || e.message?.includes('timeout')
        ? 'Inpaint処理がタイムアウトしました。画像が大きい場合やAPIの応答が遅い場合に発生します。しばらく待って再試行してください。'
        : (e.response?.data?.error || 'Inpaintに失敗しました。');
      alert(msg);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="rounded-lg border border-warm-border bg-warm-surface-alt p-4 space-y-4 shadow-warm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-stone-800">Inpaint編集</h3>
        <button onClick={onCancel} className="text-stone-500 hover:text-stone-800 transition-colors">
          <X size={18} />
        </button>
      </div>

      <p className="text-xs text-stone-500">
        修正したい部分を赤くマスクしてください。赤く塗りつぶしたマスク部分だけが修正箇所としてInpaintされます。
      </p>

      {/* モード: セリフ書き換え / イラスト修正 / テキストオーバーレイ（フェイルセーフ） */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-stone-600">種類:</span>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name="inpaintMode"
            value="serif"
            checked={inpaintMode === 'serif'}
            onChange={() => setInpaintMode('serif')}
            className="accent-amber-600"
          />
          <span className="text-xs text-stone-700">セリフを書き換える</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name="inpaintMode"
            value="illustration"
            checked={inpaintMode === 'illustration'}
            onChange={() => setInpaintMode('illustration')}
            className="accent-amber-600"
          />
          <span className="text-xs text-stone-700">イラストを修正する</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name="inpaintMode"
            value="overlay"
            checked={inpaintMode === 'overlay'}
            onChange={() => setInpaintMode('overlay')}
            className="accent-amber-600"
          />
          <span className="text-xs text-stone-700">テキストオーバーレイ（フェイルセーフ）</span>
        </label>
      </div>
      {(inpaintMode === 'serif' || inpaintMode === 'overlay') && (
        <p className="text-xs text-stone-600 bg-stone-50 border border-stone-200 rounded px-2 py-1">
          <strong>「文言」</strong>→白塗り+黒文字／<strong>文言のみ</strong>→黒文字のみ／<strong>**削除</strong>→白塗りのみ　｜　<strong>++</strong>付きで黒塗り+白文字（例: ++「文言」、++削除）
        </p>
      )}
      {inpaintMode === 'overlay' && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-stone-600">向き:</span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="overlayVertical"
                checked={overlayVertical}
                onChange={() => setOverlayVertical(true)}
                className="accent-amber-600"
              />
              <span className="text-xs text-stone-700">縦書き</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="overlayVertical"
                checked={!overlayVertical}
                onChange={() => setOverlayVertical(false)}
                className="accent-amber-600"
              />
              <span className="text-xs text-stone-700">横書き</span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="overlayFontScale" className="text-xs text-stone-600 whitespace-nowrap">文字サイズ倍率:</label>
            <input
              id="overlayFontScale"
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={overlayFontScale}
              onChange={(e) => setOverlayFontScale(parseFloat(e.target.value))}
              className="w-24 accent-amber-600"
            />
            <span className="text-xs text-stone-600 w-10">{overlayFontScale.toFixed(1)}</span>
          </div>
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
            AIを使わず、指定した文言をフォントでマスク部分に重ねます。セリフモードで吹き出しが描かれてしまった場合などに利用してください。フォントは環境の日本語フォントを使用します。文字が小さく表示される場合は倍率を上げてください。
          </p>
        </>
      )}

      {/* 詳細設定: マスクマージン・エッジぼかし */}
      <details className="group">
        <summary className="text-xs text-stone-600 cursor-pointer hover:text-stone-800 select-none">詳細設定</summary>
        <div className="mt-2 flex flex-wrap items-center gap-4 pl-2 border-l-2 border-stone-200">
          <div className="flex items-center gap-2">
            <label htmlFor="maskMargin" className="text-xs text-stone-600 whitespace-nowrap">マスクマージン (px):</label>
            <input
              id="maskMargin"
              type="number"
              min={0}
              max={20}
              value={maskMargin}
              onChange={(e) => setMaskMargin(Math.max(0, Math.min(20, parseInt(e.target.value, 10) || 0)))}
              className="w-14 rounded border border-warm-border bg-warm-surface px-2 py-1 text-xs text-stone-800"
            />
            <span className="text-xs text-stone-400">0〜20（塗り漏れ防止で境界を広げる）</span>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="edgeFeather" className="text-xs text-stone-600 whitespace-nowrap">エッジぼかし (px):</label>
            <input
              id="edgeFeather"
              type="number"
              min={0}
              max={8}
              value={edgeFeather}
              onChange={(e) => setEdgeFeather(Math.max(0, Math.min(8, parseInt(e.target.value, 10) || 0)))}
              className="w-14 rounded border border-warm-border bg-warm-surface px-2 py-1 text-xs text-stone-800"
            />
            <span className="text-xs text-stone-400">0〜8（イラスト修正時のみ、境界のなめらかさ）</span>
          </div>
        </div>
      </details>

      {/* ツールバー */}
      <div className="flex items-center gap-4">
        <div className="flex gap-1">
          <button
            onClick={() => setTool('brush')}
            className={`p-2 rounded-lg transition-colors ${tool === 'brush' ? 'bg-amber-600 text-white' : 'bg-warm-surface border border-warm-border text-stone-700'}`}
          >
            <Paintbrush size={16} />
          </button>
          <button
            onClick={() => setTool('eraser')}
            className={`p-2 rounded-lg transition-colors ${tool === 'eraser' ? 'bg-amber-600 text-white' : 'bg-warm-surface border border-warm-border text-stone-700'}`}
          >
            <Eraser size={16} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-stone-600">ブラシサイズ:</label>
          <input
            type="range"
            min="5"
            max="50"
            value={brushSize}
            onChange={(e) => setBrushSize(parseInt(e.target.value, 10))}
            className="w-24 accent-amber-600"
          />
          <span className="text-xs w-6 text-stone-600">{brushSize}</span>
        </div>
        <button
          onClick={clearMask}
          className="text-xs text-stone-500 hover:text-stone-800 transition-colors"
        >
          マスククリア
        </button>
      </div>

      {/* キャンバス（背景に画像、前面にマスク描画。アスペクト比を維持してマスクと元画像のずれを防ぐ） */}
      <div className="relative bg-stone-200 rounded-lg overflow-hidden" style={imgElement ? { aspectRatio: `${imgElement.naturalWidth || imgElement.width}/${imgElement.naturalHeight || imgElement.height}` } : undefined}>
        {!imageLoaded && (
          <div className="flex items-center justify-center py-8 text-stone-500">
            <Loader2 className="animate-spin mr-2" size={16} />
            画像を読み込み中...
          </div>
        )}
        {/* 背景画像（object-contain でアスペクト比維持、マスクと1:1対応） */}
        {imgElement && (
          <img
            src={`/generated/${imagePath}`}
            alt="編集対象画像"
            className="absolute inset-0 w-full h-full object-contain pointer-events-none"
            style={{ display: imageLoaded ? 'block' : 'none' }}
          />
        )}
        {/* マスク描画用キャンバス（画像と完全重なるよう inset-0、同一アスペクト比） */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full cursor-crosshair"
          style={{ display: imageLoaded ? 'block' : 'none' }}
          onMouseDown={startDrawing}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onMouseMove={draw}
        />
      </div>

      {/* 指示入力 */}
      <div>
        <label className="text-xs font-medium block mb-1 text-stone-700">修正指示</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={(inpaintMode === 'serif' || inpaintMode === 'overlay')
            ? '例: 「こんにちは」／**削除／++「こんにちは」'
            : '例: マスクした部分を笑顔に変更して'}
          className="w-full rounded-lg border border-warm-border bg-warm-surface px-3 py-2 text-sm h-16 text-stone-800 placeholder-stone-400 shadow-warm"
        />
      </div>

      {/* 実行ボタン */}
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-lg border border-warm-border bg-warm-surface px-4 py-2 text-sm text-stone-700 hover:bg-stone-200 transition-colors"
        >
          キャンセル
        </button>
        <button
          onClick={handleSubmit}
          disabled={isProcessing}
          className="inline-flex items-center gap-2 rounded-lg border border-amber-600 bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-60 transition-colors"
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
