import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react';
import { Loader2, MousePointer2, ScanSearch } from 'lucide-react';
import type {
  BrowserInspectedElement,
  BrowserViewerState,
  WorkbenchElementSelection,
  WorkbenchInteractionMode,
} from './types';

interface BrowserPoint {
  x: number;
  y: number;
}

interface BrowserRegion extends BrowserPoint {
  width: number;
  height: number;
}

interface BrowserSurfaceProps {
  viewer: BrowserViewerState | null;
  mode: WorkbenchInteractionMode;
  zoom: number;
  busy: boolean;
  hoveredElement: BrowserInspectedElement | null;
  selections: WorkbenchElementSelection[];
  onAction: (payload: Record<string, unknown>) => void;
  onBrowserInput: (payload: Record<string, unknown>) => void;
  onHoverPoint: (point: BrowserPoint | null) => void;
  onRegionSelected: (region: BrowserRegion) => void;
  onStreamHealthChange: (healthy: boolean) => void;
}

function labelForElement(element: BrowserInspectedElement) {
  const label = element.accessibleName || element.textSnippet || element.attributes.id || '';
  const trimmed = label.replace(/\s+/g, ' ').trim();
  const prefix = element.sourceHint?.component || element.role || element.tagName;
  return trimmed ? `${prefix} · ${trimmed.slice(0, 54)}` : prefix;
}

export function BrowserSurface({
  viewer,
  mode,
  zoom,
  busy,
  hoveredElement,
  selections,
  onAction,
  onBrowserInput,
  onHoverPoint,
  onRegionSelected,
  onStreamHealthChange,
}: BrowserSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const streamImageRef = useRef<HTMLImageElement | null>(null);
  const pointerStartRef = useRef<{ browser: BrowserPoint; button: number; clientX: number; clientY: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const browserHoverTimerRef = useRef<number | null>(null);
  const browserHoverPointRef = useRef<BrowserPoint | null>(null);
  const wheelTimerRef = useRef<number | null>(null);
  const wheelDeltaRef = useRef({ x: 0, y: 0 });
  const typingTimerRef = useRef<number | null>(null);
  const streamRetryTimerRef = useRef<number | null>(null);
  const typingBufferRef = useRef('');
  const [naturalSize, setNaturalSize] = useState({ width: 1440, height: 1000 });
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const [regionDraft, setRegionDraft] = useState<BrowserRegion | null>(null);
  const [failedStreamUrl, setFailedStreamUrl] = useState<string | null>(null);
  const [streamReady, setStreamReady] = useState(false);
  const [showBusy, setShowBusy] = useState(false);

  const frameUrl = viewer?.frame?.imageUrl || null;
  const streamUrl = viewer?.frame?.streamUrl || null;
  const canRenderStream = Boolean(streamUrl && failedStreamUrl !== streamUrl);
  const currentSelections = useMemo(() => selections.filter((selection) => (
    selection.tabId === viewer?.currentTabId
    && (!selection.url || !viewer?.currentUrl || selection.url === viewer.currentUrl)
  )), [selections, viewer?.currentTabId, viewer?.currentUrl]);

  useEffect(() => () => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    if (browserHoverTimerRef.current !== null) window.clearTimeout(browserHoverTimerRef.current);
    if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current);
    if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current);
    if (streamRetryTimerRef.current !== null) window.clearTimeout(streamRetryTimerRef.current);
  }, []);

  useEffect(() => {
    setFailedStreamUrl(null);
    setStreamReady(false);
    onStreamHealthChange(false);
  }, [onStreamHealthChange, streamUrl]);

  useEffect(() => {
    if (!busy) {
      setShowBusy(false);
      return undefined;
    }
    const timerId = window.setTimeout(() => setShowBusy(true), 280);
    return () => window.clearTimeout(timerId);
  }, [busy]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return undefined;

    const measure = () => {
      setSurfaceSize({ width: surface.clientWidth, height: surface.clientHeight });
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [frameUrl]);

  const fitScale = useMemo(() => {
    if (!surfaceSize.width || !surfaceSize.height) return 1;
    const availableWidth = Math.max(1, surfaceSize.width - 24);
    const availableHeight = Math.max(1, surfaceSize.height - 24);
    return Math.min(1, availableWidth / naturalSize.width, availableHeight / naturalSize.height);
  }, [naturalSize.height, naturalSize.width, surfaceSize.height, surfaceSize.width]);

  const displayScale = Math.max(0.2, Math.min(1.8, fitScale * zoom));
  const displaySize = {
    width: Math.max(1, Math.round(naturalSize.width * displayScale)),
    height: Math.max(1, Math.round(naturalSize.height * displayScale)),
  };

  function flushTypingBuffer() {
    if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
    const text = typingBufferRef.current;
    typingBufferRef.current = '';
    if (text) onAction({ action: 'type', tabId: viewer?.currentTabId, text });
  }

  const browserPointFromClient = useCallback((clientX: number, clientY: number): BrowserPoint | null => {
    const image = streamReady && streamImageRef.current ? streamImageRef.current : imageRef.current;
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    const x = Math.max(0, Math.min(naturalSize.width, ((clientX - rect.left) / rect.width) * naturalSize.width));
    const y = Math.max(0, Math.min(naturalSize.height, ((clientY - rect.top) / rect.height) * naturalSize.height));
    return { x, y };
  }, [naturalSize.height, naturalSize.width, streamReady]);

  function handleStreamError() {
    if (!streamUrl) return;
    setStreamReady(false);
    onStreamHealthChange(false);
    setFailedStreamUrl(streamUrl);
    if (streamRetryTimerRef.current !== null) window.clearTimeout(streamRetryTimerRef.current);
    streamRetryTimerRef.current = window.setTimeout(() => {
      setFailedStreamUrl((current) => current === streamUrl ? null : current);
      streamRetryTimerRef.current = null;
    }, 3_000);
  }

  function recordNaturalSize(image: HTMLImageElement) {
    setNaturalSize({
      width: image.naturalWidth || 1440,
      height: image.naturalHeight || 1000,
    });
  }

  function scheduleHover(point: BrowserPoint | null) {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current);
    if (!point) {
      onHoverPoint(null);
      return;
    }
    hoverTimerRef.current = window.setTimeout(() => onHoverPoint(point), 140);
  }

  function scheduleBrowserHover(point: BrowserPoint) {
    browserHoverPointRef.current = point;
    if (browserHoverTimerRef.current !== null) return;
    browserHoverTimerRef.current = window.setTimeout(() => {
      browserHoverTimerRef.current = null;
      const nextPoint = browserHoverPointRef.current;
      browserHoverPointRef.current = null;
      if (!nextPoint) return;
      onBrowserInput({
        input: 'hover',
        tabId: viewer?.currentTabId,
        x: nextPoint.x,
        y: nextPoint.y,
      });
    }, 32);
  }

  function flushWheelInput() {
    if (wheelTimerRef.current !== null) window.clearTimeout(wheelTimerRef.current);
    wheelTimerRef.current = null;
    const deltaX = Math.max(-2_400, Math.min(2_400, wheelDeltaRef.current.x));
    const deltaY = Math.max(-2_400, Math.min(2_400, wheelDeltaRef.current.y));
    wheelDeltaRef.current = { x: 0, y: 0 };
    if (!deltaX && !deltaY) return;
    onBrowserInput({
      input: 'scroll',
      tabId: viewer?.currentTabId,
      deltaX,
      deltaY,
    });
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    flushTypingBuffer();
    if (!frameUrl) return;
    const point = browserPointFromClient(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStartRef.current = { browser: point, button: event.button, clientX: event.clientX, clientY: event.clientY };
    if (mode === 'region') {
      setRegionDraft({ ...point, width: 0, height: 0 });
    }
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const point = browserPointFromClient(event.clientX, event.clientY);
    if (!point) return;
    if (mode === 'browse' && !pointerStartRef.current) scheduleBrowserHover(point);
    else if (mode === 'select' || mode === 'multi-select') scheduleHover(point);

    if (mode === 'region' && pointerStartRef.current) {
      const start = pointerStartRef.current.browser;
      setRegionDraft({
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y),
      });
    }
  }

  function handlePointerLeave() {
    if (mode === 'select' || mode === 'multi-select') scheduleHover(null);
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = pointerStartRef.current;
    pointerStartRef.current = null;
    if (!start) return;
    const point = browserPointFromClient(event.clientX, event.clientY);
    if (!point) return;

    if (mode === 'region') {
      const region = {
        x: Math.min(start.browser.x, point.x),
        y: Math.min(start.browser.y, point.y),
        width: Math.abs(point.x - start.browser.x),
        height: Math.abs(point.y - start.browser.y),
      };
      setRegionDraft(null);
      if (region.width >= 8 && region.height >= 8) onRegionSelected(region);
      return;
    }

    if (mode === 'select' || mode === 'multi-select') {
      onAction({ action: 'inspect', tabId: viewer?.currentTabId, x: point.x, y: point.y });
      return;
    }

    const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
    if (moved > 7 && start.button === 0) {
      onAction({
        action: 'drag',
        tabId: viewer?.currentTabId,
        startX: start.browser.x,
        startY: start.browser.y,
        endX: point.x,
        endY: point.y,
      });
      return;
    }
    onAction({
      action: 'click',
      tabId: viewer?.currentTabId,
      x: point.x,
      y: point.y,
      button: start.button === 2 ? 'right' : 'left',
      clickCount: start.button === 0 && event.detail > 1 ? 2 : 1,
    });
  }

  function handlePointerCancel() {
    pointerStartRef.current = null;
    setRegionDraft(null);
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (!frameUrl) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? naturalSize.height : 1;
    wheelDeltaRef.current.x += event.deltaX * unit;
    wheelDeltaRef.current.y += event.deltaY * unit;
    if (wheelTimerRef.current === null) {
      wheelTimerRef.current = window.setTimeout(flushWheelInput, 24);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    if (!frameUrl || mode !== 'browse') return;
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    flushTypingBuffer();
    onAction({ action: 'type', tabId: viewer?.currentTabId, text });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!frameUrl || mode !== 'browse') return;
    const passthroughKeys = new Set([
      'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown',
      'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space',
    ]);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      flushTypingBuffer();
      event.preventDefault();
      void navigator.clipboard.readText().then((text) => {
        if (text) onAction({ action: 'type', tabId: viewer?.currentTabId, text });
      }).catch(() => {
        onAction({ action: 'key', tabId: viewer?.currentTabId, key: `${event.metaKey ? 'Meta' : 'Control'}+v` });
      });
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      flushTypingBuffer();
      const modifiers = [event.ctrlKey ? 'Control' : '', event.metaKey ? 'Meta' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '']
        .filter(Boolean)
        .join('+');
      onAction({ action: 'key', tabId: viewer?.currentTabId, key: `${modifiers}+${event.key}` });
      event.preventDefault();
      return;
    }
    if (passthroughKeys.has(event.key)) {
      flushTypingBuffer();
      onAction({ action: 'key', tabId: viewer?.currentTabId, key: event.key === 'Space' ? ' ' : event.key });
      event.preventDefault();
      return;
    }
    if (event.key.length === 1) {
      typingBufferRef.current += event.key;
      if (typingTimerRef.current !== null) window.clearTimeout(typingTimerRef.current);
      typingTimerRef.current = window.setTimeout(flushTypingBuffer, 90);
      event.preventDefault();
    }
  }

  const overlayFor = (element: BrowserInspectedElement, key: string, tone: 'hover' | 'selected') => {
    const rect = element.rect;
    const left = `${(rect.x / naturalSize.width) * 100}%`;
    const top = `${(rect.y / naturalSize.height) * 100}%`;
    const width = `${(rect.width / naturalSize.width) * 100}%`;
    const height = `${(rect.height / naturalSize.height) * 100}%`;
    return (
      <div
        key={key}
        className={tone === 'hover'
          ? 'pointer-events-none absolute z-20 border border-violet-500 bg-violet-300/10 shadow-[0_0_0_1px_rgba(255,255,255,0.8)]'
          : 'pointer-events-none absolute z-10 border-2 border-sky-500 bg-sky-300/10 shadow-[0_0_0_1px_rgba(255,255,255,0.9)]'}
        style={{ left, top, width, height }}
      >
        <span className={tone === 'hover'
          ? 'absolute -top-6 left-0 max-w-72 truncate rounded-md bg-violet-600 px-2 py-1 text-[10px] font-medium text-white shadow-sm'
          : 'absolute -top-6 left-0 max-w-72 truncate rounded-md bg-sky-600 px-2 py-1 text-[10px] font-medium text-white shadow-sm'}>
          {labelForElement(element)}
        </span>
      </div>
    );
  };

  if (!frameUrl) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-8" dir="rtl">
        <div className="max-w-md rounded-3xl border border-slate-200 bg-white px-8 py-10 text-center shadow-[0_22px_70px_-52px_rgba(15,23,42,0.28)]">
          {busy ? <Loader2 className="mx-auto h-7 w-7 animate-spin text-slate-400" /> : <ScanSearch className="mx-auto h-8 w-8 text-slate-300" />}
          <h2 className="mt-4 text-base font-semibold text-slate-800">{busy ? 'פותח סביבת דפדפן…' : 'מוכן להצגת האתר'}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            הזן כתובת בסרגל העליון. האתר ייפתח בדפדפן מבודד שמחובר לאותו סשן Code‑AI.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={surfaceRef}
      tabIndex={0}
      data-workbench-fit-scale={fitScale.toFixed(4)}
      data-workbench-display-scale={displayScale.toFixed(4)}
      data-workbench-frame-mode={streamReady ? 'live' : 'snapshot'}
      data-workbench-surface-size={`${surfaceSize.width}x${surfaceSize.height}`}
      className="relative h-full min-h-0 w-full select-none overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-200"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onContextMenu={(event) => event.preventDefault()}
      title={mode === 'browse' ? 'לחץ וגלול בתוך האתר' : 'בחר אלמנט כדי לצרף אותו ל־Code‑AI'}
    >
      <div className="flex min-h-full min-w-full items-center justify-center p-3">
        <div
          className="relative shrink-0 transition-[width,height] duration-200 ease-out"
          style={{ width: displaySize.width, height: displaySize.height }}
        >
          <img
            ref={imageRef}
            src={frameUrl}
            alt={viewer?.currentTitle || 'Website preview'}
            draggable={false}
            onLoad={(event) => recordNaturalSize(event.currentTarget)}
            className={mode === 'browse'
              ? 'block h-full w-full max-w-none rounded-xl border border-slate-200 bg-white object-fill shadow-[0_16px_60px_-48px_rgba(15,23,42,0.42)]'
              : 'block h-full w-full max-w-none cursor-crosshair rounded-xl border border-slate-200 bg-white object-fill shadow-[0_16px_60px_-48px_rgba(15,23,42,0.42)]'}
          />

          {canRenderStream && streamUrl ? (
            <img
              ref={streamImageRef}
              src={streamUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
              onLoad={(event) => {
                recordNaturalSize(event.currentTarget);
                setStreamReady(true);
                onStreamHealthChange(true);
              }}
              onError={handleStreamError}
              className={mode === 'browse'
                ? `absolute inset-0 block h-full w-full max-w-none rounded-xl border border-slate-200 bg-white object-fill shadow-[0_16px_60px_-48px_rgba(15,23,42,0.42)] transition-opacity duration-150 ${streamReady ? 'opacity-100' : 'opacity-0'}`
                : `absolute inset-0 block h-full w-full max-w-none cursor-crosshair rounded-xl border border-slate-200 bg-white object-fill shadow-[0_16px_60px_-48px_rgba(15,23,42,0.42)] transition-opacity duration-150 ${streamReady ? 'opacity-100' : 'opacity-0'}`}
            />
          ) : null}

          {currentSelections.map((selection) => overlayFor(selection.element, selection.selectionId, 'selected'))}
          {hoveredElement && (mode === 'select' || mode === 'multi-select')
            ? overlayFor(hoveredElement, 'hovered-element', 'hover')
            : null}

          {regionDraft && (
            <div
              className="pointer-events-none absolute z-30 border-2 border-dashed border-violet-500 bg-violet-300/15"
              style={{
                left: `${(regionDraft.x / naturalSize.width) * 100}%`,
                top: `${(regionDraft.y / naturalSize.height) * 100}%`,
                width: `${(regionDraft.width / naturalSize.width) * 100}%`,
                height: `${(regionDraft.height / naturalSize.height) * 100}%`,
              }}
            />
          )}
        </div>
      </div>

      {showBusy && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-white/20 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 py-2 text-xs font-medium text-slate-600 shadow-sm" dir="rtl">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            מעדכן תצוגה
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/90 px-2.5 py-1.5 text-[10px] text-slate-500 shadow-sm backdrop-blur" dir="rtl">
        <MousePointer2 className="h-3 w-3" />
        {mode === 'browse' ? 'מצב גלישה' : mode === 'region' ? 'גרור לבחירת אזור' : 'לחץ לבחירת אלמנט'}
      </div>
    </div>
  );
}
