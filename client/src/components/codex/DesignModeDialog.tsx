import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowUpRight,
  Eraser,
  Highlighter,
  ImagePlus,
  Palette,
  Pencil,
  Redo2,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CodexSessionDesignModeValue {
  enabled: boolean;
  geminiProfileId: string;
  quality: 'balanced' | 'deep';
  brief: string;
  canvasAvailable: boolean;
  canvasUpdatedAt: string | null;
}

export interface DesignModeProfileOption {
  id: string;
  label: string;
}

type CanvasTool = 'pen' | 'marker' | 'rectangle' | 'arrow' | 'eraser';

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const MAX_HISTORY_STEPS = 20;
const DRAWING_COLORS = ['#111827', '#7c3aed', '#2563eb', '#0891b2', '#059669', '#d97706', '#e11d48', '#ffffff'];

function paintBlankCanvas(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.save();
  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = 1;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.restore();
}

function loadCanvasSnapshot(canvas: HTMLCanvasElement, source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('Canvas context is unavailable'));
        return;
      }
      context.save();
      context.globalCompositeOperation = 'source-over';
      context.globalAlpha = 1;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      context.restore();
      resolve();
    };
    image.onerror = () => reject(new Error('Failed to load the design canvas'));
    image.src = source;
  });
}

function drawArrow(
  context: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): void {
  const angle = Math.atan2(endY - startY, endX - startX);
  const headLength = Math.max(18, context.lineWidth * 4);
  context.beginPath();
  context.moveTo(startX, startY);
  context.lineTo(endX, endY);
  context.moveTo(endX, endY);
  context.lineTo(
    endX - headLength * Math.cos(angle - Math.PI / 6),
    endY - headLength * Math.sin(angle - Math.PI / 6),
  );
  context.moveTo(endX, endY);
  context.lineTo(
    endX - headLength * Math.cos(angle + Math.PI / 6),
    endY - headLength * Math.sin(angle + Math.PI / 6),
  );
  context.stroke();
}

function toolLabel(tool: CanvasTool): string {
  if (tool === 'pen') return 'עט';
  if (tool === 'marker') return 'מרקר';
  if (tool === 'rectangle') return 'מלבן';
  if (tool === 'arrow') return 'חץ';
  return 'מחק';
}

export function DesignModeDialog({
  isOpen,
  provider,
  value,
  profiles,
  canvasUrl,
  isSaving,
  onClose,
  onChange,
  onSave,
  onDisable,
}: {
  isOpen: boolean;
  provider: 'codex' | 'claude' | 'gemini' | null;
  value: CodexSessionDesignModeValue;
  profiles: DesignModeProfileOption[];
  canvasUrl: string | null;
  isSaving: boolean;
  onClose: () => void;
  onChange: (value: CodexSessionDesignModeValue) => void;
  onSave: (canvasFile: File | null, clearCanvas: boolean) => Promise<void> | void;
  onDisable: () => Promise<void> | void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const drawingRef = useRef(false);
  const startPointRef = useRef({ x: 0, y: 0 });
  const lastPointRef = useRef({ x: 0, y: 0 });
  const shapeBaseRef = useRef<ImageData | null>(null);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const initializationIdRef = useRef(0);
  const [tool, setTool] = useState<CanvasTool>('pen');
  const [color, setColor] = useState('#7c3aed');
  const [strokeWidth, setStrokeWidth] = useState(8);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyLength, setHistoryLength] = useState(0);
  const [isCanvasDirty, setIsCanvasDirty] = useState(false);
  const [clearCanvasOnSave, setClearCanvasOnSave] = useState(false);
  const [canvasError, setCanvasError] = useState<string | null>(null);

  const codexOnly = provider === 'codex';

  function replaceHistory(nextHistory: string[], nextIndex: number): void {
    historyRef.current = nextHistory;
    historyIndexRef.current = nextIndex;
    setHistoryLength(nextHistory.length);
    setHistoryIndex(nextIndex);
  }

  function commitCanvasSnapshot(): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const snapshot = canvas.toDataURL('image/png');
    const retained = historyRef.current.slice(0, historyIndexRef.current + 1);
    retained.push(snapshot);
    const nextHistory = retained.slice(-MAX_HISTORY_STEPS);
    replaceHistory(nextHistory, nextHistory.length - 1);
    setIsCanvasDirty(true);
    setClearCanvasOnSave(false);
  }

  async function restoreHistoryAt(index: number): Promise<void> {
    const canvas = canvasRef.current;
    const snapshot = historyRef.current[index];
    if (!canvas || !snapshot) return;
    await loadCanvasSnapshot(canvas, snapshot);
    historyIndexRef.current = index;
    setHistoryIndex(index);
    setIsCanvasDirty(true);
    setClearCanvasOnSave(false);
  }

  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const initializationId = ++initializationIdRef.current;
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    setCanvasError(null);
    setIsCanvasDirty(false);
    setClearCanvasOnSave(false);
    const initialize = async () => {
      try {
        if (canvasUrl) {
          // Every authenticated fetch creates a fresh object URL. Appending a query
          // string to a blob: URL makes it invalid in several Chromium versions.
          await loadCanvasSnapshot(canvas, canvasUrl);
        } else {
          paintBlankCanvas(canvas);
        }
        if (initializationId !== initializationIdRef.current) return;
        const snapshot = canvas.toDataURL('image/png');
        replaceHistory([snapshot], 0);
      } catch (error: any) {
        if (initializationId !== initializationIdRef.current) return;
        paintBlankCanvas(canvas);
        replaceHistory([canvas.toDataURL('image/png')], 0);
        setCanvasError(error.message || 'לא ניתן היה לטעון את הקנבס השמור.');
      }
    };
    void initialize();
    return () => {
      initializationIdRef.current += 1;
      drawingRef.current = false;
      shapeBaseRef.current = null;
    };
  }, [canvasUrl, isOpen, value.canvasUpdatedAt]);

  if (!isOpen) return null;

  function canvasPoint(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    };
  }

  function configureContext(context: CanvasRenderingContext2D): void {
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = tool === 'marker' ? strokeWidth * 2.5 : strokeWidth;
    context.strokeStyle = tool === 'eraser' ? '#ffffff' : color;
    context.fillStyle = tool === 'eraser' ? '#ffffff' : color;
    context.globalAlpha = tool === 'marker' ? 0.28 : 1;
    context.globalCompositeOperation = 'source-over';
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (event.button !== 0) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = canvasPoint(event);
    drawingRef.current = true;
    startPointRef.current = point;
    lastPointRef.current = point;
    configureContext(context);
    if (tool === 'rectangle' || tool === 'arrow') {
      shapeBaseRef.current = context.getImageData(0, 0, event.currentTarget.width, event.currentTarget.height);
      return;
    }
    context.beginPath();
    context.arc(point.x, point.y, Math.max(1, context.lineWidth / 2), 0, Math.PI * 2);
    context.fill();
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!drawingRef.current) return;
    const context = event.currentTarget.getContext('2d');
    if (!context) return;
    const point = canvasPoint(event);
    configureContext(context);
    if (tool === 'rectangle' || tool === 'arrow') {
      if (shapeBaseRef.current) context.putImageData(shapeBaseRef.current, 0, 0);
      context.beginPath();
      if (tool === 'rectangle') {
        context.strokeRect(
          startPointRef.current.x,
          startPointRef.current.y,
          point.x - startPointRef.current.x,
          point.y - startPointRef.current.y,
        );
      } else {
        drawArrow(context, startPointRef.current.x, startPointRef.current.y, point.x, point.y);
      }
    } else {
      context.beginPath();
      context.moveTo(lastPointRef.current.x, lastPointRef.current.y);
      context.lineTo(point.x, point.y);
      context.stroke();
    }
    lastPointRef.current = point;
  }

  function finishDrawing(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (!drawingRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    handlePointerMove(event);
    drawingRef.current = false;
    shapeBaseRef.current = null;
    commitCanvasSnapshot();
  }

  function clearCanvas(): void {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paintBlankCanvas(canvas);
    commitCanvasSnapshot();
  }

  function removeCanvas(): void {
    const canvas = canvasRef.current;
    if (canvas) {
      paintBlankCanvas(canvas);
      replaceHistory([canvas.toDataURL('image/png')], 0);
    }
    setClearCanvasOnSave(true);
    setIsCanvasDirty(false);
    setCanvasError(null);
  }

  async function importImage(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const canvas = canvasRef.current;
    if (!file || !canvas) return;
    if (!file.type.startsWith('image/')) {
      setCanvasError('יש לבחור קובץ תמונה.');
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('לא ניתן לטעון את התמונה שנבחרה.'));
        image.src = objectUrl;
      });
      const context = canvas.getContext('2d');
      if (!context) return;
      paintBlankCanvas(canvas);
      const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      commitCanvasSnapshot();
      setCanvasError(null);
    } catch (error: any) {
      setCanvasError(error.message || 'לא ניתן לטעון את התמונה שנבחרה.');
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function saveMode(): Promise<void> {
    let canvasFile: File | null = null;
    const canvas = canvasRef.current;
    if (isCanvasDirty && !clearCanvasOnSave && canvas) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) {
        setCanvasError('לא ניתן היה להכין את הקנבס לשמירה.');
        return;
      }
      canvasFile = new File([blob], 'design-canvas.png', { type: 'image/png' });
    }
    await onSave(canvasFile, clearCanvasOnSave);
  }

  const tools: Array<{ id: CanvasTool; icon: typeof Pencil }> = [
    { id: 'pen', icon: Pencil },
    { id: 'marker', icon: Highlighter },
    { id: 'rectangle', icon: Square },
    { id: 'arrow', icon: ArrowUpRight },
    { id: 'eraser', icon: Eraser },
  ];

  return (
    <div className="fixed inset-0 z-[79] flex items-end justify-center bg-slate-950/25 p-3 backdrop-blur-sm sm:items-center sm:p-5" dir="rtl">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onClose} aria-label="סגור מצב עיצוב" />
      <div className="relative z-10 flex max-h-[94dvh] w-full max-w-5xl flex-col overflow-hidden rounded-[2rem] border border-violet-100 bg-white shadow-[0_35px_120px_-45px_rgba(76,29,149,0.48)]">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-6">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet-50 text-violet-700">
              <Palette className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-400">Design Mode</div>
              <div className="mt-0.5 text-lg font-semibold text-slate-900">מצב עיצוב · Codex × Gemini</div>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500">
                Gemini נותן כיוון חזותי מדויק; Codex שומר על הקוד, הלוגיקה וכל היכולות ומטמיע רק patch ממוקד.
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-50 p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          {!codexOnly && (
            <div className="mb-4 rounded-[1.2rem] border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
              מצב עיצוב זמין רק בפרופיל Codex. הוא לא יטען סקיל או כלי MCP בפרופיל אחר.
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.75fr)]">
            <section className="min-w-0 rounded-[1.6rem] border border-violet-100 bg-violet-50/30 p-3 sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-slate-800">קנבס כוונת המשתמש</div>
                  <div className="mt-1 text-[11px] leading-5 text-slate-500">
                    צייר מסך, סמן אזור או ייבא צילום. Codex יחליט בכל כלי אם לשלוח הכול, חיתוך ממוקד או לא לשלוח כלל.
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {tools.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        title={toolLabel(item.id)}
                        onClick={() => setTool(item.id)}
                        className={cn(
                          'flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition',
                          tool === item.id
                            ? 'border-violet-300 bg-violet-600 text-white'
                            : 'border-white bg-white text-slate-600 hover:border-violet-200 hover:text-violet-700',
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">{toolLabel(item.id)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-[1.15rem] border border-white bg-white/80 px-3 py-2.5">
                <div className="flex items-center gap-1.5" aria-label="צבע ציור">
                  {DRAWING_COLORS.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setColor(option)}
                      className={cn('h-6 w-6 rounded-full border-2 transition', color === option ? 'scale-110 border-violet-500' : 'border-white shadow-sm')}
                      style={{ backgroundColor: option }}
                      aria-label={`בחר צבע ${option}`}
                    />
                  ))}
                </div>
                <label className="flex min-w-[8rem] flex-1 items-center gap-2 text-[11px] text-slate-500">
                  עובי
                  <input
                    type="range"
                    min="2"
                    max="28"
                    value={strokeWidth}
                    onChange={(event) => setStrokeWidth(Number(event.currentTarget.value))}
                    className="min-w-0 flex-1 accent-violet-600"
                  />
                </label>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => void restoreHistoryAt(historyIndex - 1)} disabled={historyIndex <= 0} className="rounded-full p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-30" title="בטל">
                    <Undo2 className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => void restoreHistoryAt(historyIndex + 1)} disabled={historyIndex < 0 || historyIndex >= historyLength - 1} className="rounded-full p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-30" title="בצע שוב">
                    <Redo2 className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={clearCanvas} className="rounded-full p-2 text-slate-500 hover:bg-slate-100" title="נקה ציור">
                    <RotateCcw className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="mt-3 overflow-hidden rounded-[1.25rem] border border-violet-100 bg-[linear-gradient(45deg,#f8fafc_25%,transparent_25%),linear-gradient(-45deg,#f8fafc_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f8fafc_75%),linear-gradient(-45deg,transparent_75%,#f8fafc_75%)] bg-[length:20px_20px] bg-[position:0_0,0_10px,10px_-10px,-10px_0px] shadow-inner">
                <canvas
                  ref={canvasRef}
                  className="block aspect-video w-full touch-none cursor-crosshair bg-white"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={finishDrawing}
                  onPointerCancel={finishDrawing}
                  aria-label="קנבס ציור למצב עיצוב"
                />
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => void importImage(event)} />
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => imageInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-full border border-violet-200 bg-white px-4 py-2 text-xs font-medium text-violet-700 transition hover:bg-violet-50">
                    <ImagePlus className="h-4 w-4" />
                    ייבא צילום מסך
                  </button>
                  {(value.canvasAvailable || isCanvasDirty) && (
                    <button type="button" onClick={removeCanvas} className="inline-flex items-center gap-2 rounded-full border border-rose-100 bg-white px-4 py-2 text-xs font-medium text-rose-600 transition hover:bg-rose-50">
                      <Trash2 className="h-3.5 w-3.5" />
                      הסר קנבס
                    </button>
                  )}
                </div>
                <span className="text-[10px] text-slate-400">1280 × 720 · PNG פרטי לסשן</span>
              </div>
              {canvasError && <div className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{canvasError}</div>}
            </section>

            <aside className="space-y-4">
              <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">הפעל לסשן</div>
                    <div className="mt-1 text-xs leading-5 text-slate-500">רק במצב פעיל ייטענו הסקיל וכלי העיצוב.</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={value.enabled}
                    disabled={!codexOnly}
                    onClick={() => codexOnly && onChange({ ...value, enabled: !value.enabled })}
                    dir="ltr"
                    className={cn('relative inline-flex h-7 w-12 shrink-0 rounded-full p-1 transition', value.enabled ? 'bg-violet-500' : 'bg-slate-200', !codexOnly && 'opacity-50')}
                  >
                    <span className={cn('block h-5 w-5 rounded-full bg-white shadow transition-transform', value.enabled ? 'translate-x-5' : 'translate-x-0')} />
                  </button>
                </div>
              </div>

              <div className="rounded-[1.5rem] border border-slate-100 bg-white p-4 shadow-sm">
                <label className="text-xs font-semibold text-slate-700">פרופיל Gemini המעצב</label>
                <select
                  value={value.geminiProfileId}
                  disabled={!codexOnly || profiles.length === 0}
                  onChange={(event) => onChange({ ...value, geminiProfileId: event.currentTarget.value })}
                  className="mt-2 w-full rounded-[1rem] border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none focus:border-violet-300 focus:ring-2 focus:ring-violet-100 disabled:opacity-50"
                >
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                </select>

                <div className="mt-4 text-xs font-semibold text-slate-700">עומק הייעוץ</div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {([
                    { id: 'deep' as const, label: 'עמוק', description: 'כיוון מלא ומפורט' },
                    { id: 'balanced' as const, label: 'מאוזן', description: 'מהיר וממוקד' },
                  ]).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      disabled={!codexOnly}
                      onClick={() => onChange({ ...value, quality: option.id })}
                      className={cn('rounded-[1rem] border px-3 py-3 text-right transition', value.quality === option.id ? 'border-violet-200 bg-violet-50 text-violet-800' : 'border-slate-100 bg-slate-50 text-slate-600')}
                    >
                      <div className="text-xs font-semibold">{option.label}</div>
                      <div className="mt-1 text-[10px] opacity-70">{option.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="rounded-[1.5rem] border border-slate-100 bg-white p-4 shadow-sm">
                <label className="text-xs font-semibold text-slate-700">בריף עיצוב קבוע לסשן</label>
                <textarea
                  value={value.brief}
                  onChange={(event) => onChange({ ...value, brief: event.currentTarget.value })}
                  placeholder="לדוגמה: נקי, רך, RTL מלא, בלי להסיר מידע קיים..."
                  rows={5}
                  maxLength={20000}
                  className="mt-2 min-h-[7.5rem] w-full resize-y rounded-[1rem] border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-700 outline-none placeholder:text-slate-300 focus:border-violet-300 focus:ring-2 focus:ring-violet-100"
                />
                <div className="mt-1 text-left text-[10px] text-slate-400" dir="ltr">{value.brief.length.toLocaleString()} / 20,000</div>
              </div>

              <div className="rounded-[1.5rem] border border-violet-100 bg-violet-50/60 p-4 text-xs leading-6 text-violet-900">
                <div className="flex items-center gap-2 font-semibold"><Sparkles className="h-4 w-4" />שיקול דעת בכל קריאה</div>
                <p className="mt-1 text-violet-700">
                  מסך מלא יקבל בדרך כלל קנבס מלא; קומפוננטה תקבל חיתוך מדויק; בקשה שאינה קשורה לציור לא תשלח אותו. הבחירה מתועדת בכל artifact.
                </p>
              </div>
            </aside>
          </div>
        </div>

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-white px-5 py-4 sm:px-6">
          <button type="button" onClick={() => void onDisable()} disabled={isSaving || !value.enabled} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-40">
            כבה מצב
          </button>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50">בטל</button>
            <button
              type="button"
              onClick={() => void saveMode()}
              disabled={isSaving || !codexOnly || (value.enabled && !value.geminiProfileId)}
              className="rounded-full bg-slate-950 px-5 py-2 text-sm font-medium text-white transition hover:bg-violet-900 disabled:opacity-40"
            >
              {isSaving ? 'שומר ומכין...' : 'שמור מצב עיצוב'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
