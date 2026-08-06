import {
  useEffect,
  useRef,
  useState,
} from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTermTerminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import {
  Clipboard,
  Eraser,
  Keyboard,
  Loader2,
  RotateCcw,
  SquareTerminal,
  X,
} from 'lucide-react';

export interface CodexTerminalSessionInfo {
  id: string;
  profileId: string;
  cwd: string;
  shell: string;
  createdAt: string;
  exited: boolean;
  exitCode: number | null;
  exitSignal: number | null;
}

export interface CodexTerminalOutput {
  cursor: number;
  data: string;
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
  exitSignal: number | null;
}

export interface CodexTerminalApi {
  create(columns: number, rows: number): Promise<CodexTerminalSessionInfo>;
  read(terminalId: string, cursor: number, signal: AbortSignal): Promise<CodexTerminalOutput>;
  write(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, columns: number, rows: number): Promise<void>;
  close(terminalId: string): Promise<void>;
}

interface CodexTerminalDialogProps {
  isOpen: boolean;
  cwd: string | null;
  profileLabel: string;
  serverLabel: string;
  api: CodexTerminalApi;
  onClose: () => void;
}

type TerminalStatus = 'starting' | 'active' | 'exited' | 'failed';

const INPUT_BATCH_DELAY_MS = 12;
const ACTIVE_POLL_DELAY_MS = 45;
const IDLE_POLL_DELAY_MS = 180;

function describeTerminalExit(output: Pick<CodexTerminalOutput, 'exitCode' | 'exitSignal'>): string {
  if (output.exitCode !== null) {
    return `התהליך הסתיים עם קוד ${output.exitCode}`;
  }
  if (output.exitSignal !== null) {
    return `התהליך הסתיים באות ${output.exitSignal}`;
  }
  return 'תהליך הטרמינל הסתיים';
}

function readTerminalBuffer(terminal: XTermTerminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) || '');
  }
  return lines.join('\n').replace(/\n+$/, '');
}

export function CodexTerminalDialog({
  isOpen,
  cwd,
  profileLabel,
  serverLabel,
  api,
  onClose,
}: CodexTerminalDialogProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTermTerminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const apiRef = useRef(api);
  const inputBufferRef = useRef('');
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputChainRef = useRef<Promise<void>>(Promise.resolve());
  const [status, setStatus] = useState<TerminalStatus>('starting');
  const [statusMessage, setStatusMessage] = useState('מפעיל מעטפת אינטראקטיבית…');
  const [error, setError] = useState<string | null>(null);
  const [restartKey, setRestartKey] = useState(0);

  apiRef.current = api;

  useEffect(() => {
    if (!isOpen || !cwd || !hostRef.current) {
      return;
    }

    let disposed = false;
    let pollingTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const abortController = new AbortController();
    const fitAddon = new FitAddon();
    const sessionApi = apiRef.current;
    const terminal = new XTermTerminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: false,
      drawBoldTextInBrightColors: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", "Fira Code", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      rightClickSelectsWord: true,
      scrollback: 50_000,
      tabStopWidth: 4,
      theme: {
        background: '#0b1020',
        foreground: '#e6edf7',
        cursor: '#a78bfa',
        cursorAccent: '#0b1020',
        selectionBackground: '#334155',
        selectionForeground: '#ffffff',
        black: '#111827',
        red: '#fb7185',
        green: '#86efac',
        yellow: '#fde68a',
        blue: '#93c5fd',
        magenta: '#d8b4fe',
        cyan: '#67e8f9',
        white: '#e5e7eb',
        brightBlack: '#64748b',
        brightRed: '#fda4af',
        brightGreen: '#bbf7d0',
        brightYellow: '#fef3c7',
        brightBlue: '#bfdbfe',
        brightMagenta: '#e9d5ff',
        brightCyan: '#a5f3fc',
        brightWhite: '#ffffff',
      },
    });
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    terminalRef.current = terminal;

    const fitTerminal = () => {
      if (disposed) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        return;
      }
      const terminalId = sessionIdRef.current;
      if (!terminalId || terminal.cols < 1 || terminal.rows < 1) {
        return;
      }
      void sessionApi.resize(terminalId, terminal.cols, terminal.rows).catch(() => {});
    };

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      resizeTimer = setTimeout(fitTerminal, 80);
    });
    resizeObserver.observe(hostRef.current);

    const flushInput = () => {
      inputTimerRef.current = null;
      const terminalId = sessionIdRef.current;
      const data = inputBufferRef.current;
      inputBufferRef.current = '';
      if (!terminalId || !data || disposed) {
        return;
      }
      inputChainRef.current = inputChainRef.current
        .then(() => sessionApi.write(terminalId, data))
        .catch((inputError: any) => {
          if (!disposed) {
            setError(inputError?.message || 'שליחת הקלט לטרמינל נכשלה.');
          }
        });
    };

    const dataDisposable = terminal.onData((data) => {
      if (!sessionIdRef.current || disposed) {
        return;
      }
      inputBufferRef.current += data;
      if (!inputTimerRef.current) {
        inputTimerRef.current = setTimeout(flushInput, INPUT_BATCH_DELAY_MS);
      }
    });

    const pollOutput = async (terminalId: string, cursor: number): Promise<void> => {
      if (disposed) {
        return;
      }
      try {
        const output = await sessionApi.read(terminalId, cursor, abortController.signal);
        if (disposed) {
          return;
        }
        if (output.truncated) {
          terminal.write('\r\n\x1b[33m[חלק מפלט ישן הוסר ממאגר השרת]\x1b[0m\r\n');
        }
        if (output.data) {
          terminal.write(output.data);
        }
        if (output.exited) {
          const message = describeTerminalExit(output);
          terminal.write(`\r\n\x1b[90m[${message}]\x1b[0m\r\n`);
          setStatus('exited');
          setStatusMessage(message);
          return;
        }
        pollingTimer = setTimeout(
          () => void pollOutput(terminalId, output.cursor),
          output.data ? ACTIVE_POLL_DELAY_MS : IDLE_POLL_DELAY_MS
        );
      } catch (pollError: any) {
        if (disposed || pollError?.name === 'AbortError') {
          return;
        }
        setStatus('failed');
        setStatusMessage('החיבור לטרמינל נותק');
        setError(pollError?.message || 'קריאת פלט הטרמינל נכשלה.');
      }
    };

    const start = async () => {
      setStatus('starting');
      setStatusMessage('מפעיל מעטפת אינטראקטיבית…');
      setError(null);
      sessionIdRef.current = null;
      inputBufferRef.current = '';

      try {
        fitAddon.fit();
        const session = await sessionApi.create(
          Math.max(terminal.cols, 20),
          Math.max(terminal.rows, 5)
        );
        if (disposed) {
          await sessionApi.close(session.id).catch(() => {});
          return;
        }
        sessionIdRef.current = session.id;
        setStatus('active');
        setStatusMessage(`מחובר · ${session.shell}`);
        terminal.focus();
        void pollOutput(session.id, 0);
      } catch (startError: any) {
        if (disposed) {
          return;
        }
        setStatus('failed');
        setStatusMessage('הטרמינל לא הופעל');
        setError(startError?.message || 'הפעלת הטרמינל נכשלה.');
      }
    };

    const startAnimationFrame = requestAnimationFrame(() => {
      fitTerminal();
      void start();
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(startAnimationFrame);
      abortController.abort();
      dataDisposable.dispose();
      resizeObserver.disconnect();
      if (pollingTimer) {
        clearTimeout(pollingTimer);
      }
      if (resizeTimer) {
        clearTimeout(resizeTimer);
      }
      if (inputTimerRef.current) {
        clearTimeout(inputTimerRef.current);
        inputTimerRef.current = null;
      }
      inputBufferRef.current = '';
      const terminalId = sessionIdRef.current;
      sessionIdRef.current = null;
      if (terminalId) {
        void sessionApi.close(terminalId).catch(() => {});
      }
      terminal.dispose();
      if (terminalRef.current === terminal) {
        terminalRef.current = null;
      }
    };
  }, [cwd, isOpen, restartKey]);

  if (!isOpen) {
    return null;
  }

  const copyTerminalText = async () => {
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const text = terminal.getSelection() || readTerminalBuffer(terminal);
    if (!text) {
      setStatusMessage('אין עדיין תוכן להעתקה');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatusMessage('תוכן הטרמינל הועתק');
    } catch {
      setError('הדפדפן לא אפשר להעתיק את תוכן הטרמינל.');
    }
  };

  return (
    <div className="fixed inset-0 z-[96] flex items-stretch justify-center bg-slate-950/45 p-0 backdrop-blur-sm sm:items-center sm:p-4" dir="rtl">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="סגור טרמינל"
      />
      <section className="relative z-10 flex h-[100dvh] w-full flex-col overflow-hidden bg-white shadow-2xl sm:h-[min(86dvh,52rem)] sm:max-w-6xl sm:rounded-[2rem] sm:border sm:border-slate-200">
        <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white">
                <SquareTerminal className="h-5 w-5" />
              </div>
              <div className="min-w-0 text-right">
                <div className="text-sm font-bold text-slate-900">טרמינל</div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  {profileLabel} · {serverLabel}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => terminalRef.current?.focus()}
                className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100"
                title="פתח מקלדת"
                aria-label="פתח מקלדת"
              >
                <Keyboard className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => void copyTerminalText()}
                className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100"
                title="העתק פלט או בחירה"
                aria-label="העתק פלט או בחירה"
              >
                <Clipboard className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => terminalRef.current?.clear()}
                className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100"
                title="נקה תצוגה"
                aria-label="נקה תצוגה"
              >
                <Eraser className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setRestartKey((current) => current + 1)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-100"
                title="הפעל מעטפת חדשה"
                aria-label="הפעל מעטפת חדשה"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-slate-500 transition hover:bg-slate-200"
                title="סגור"
                aria-label="סגור"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div
            className="mt-3 overflow-x-auto whitespace-nowrap rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-left font-mono text-[11px] text-slate-500"
            dir="ltr"
            title={cwd || undefined}
          >
            {cwd || 'No active directory'}
          </div>
        </header>

        <div className="relative min-h-0 flex-1 overflow-hidden bg-[#0b1020]" dir="ltr">
          <div
            ref={hostRef}
            className="absolute inset-0 overflow-hidden px-2 py-3 text-left sm:px-3"
            dir="ltr"
            style={{ direction: 'ltr', textAlign: 'left' }}
          />
          {status === 'starting' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#0b1020]/85">
              <div className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-4 py-2 text-xs text-slate-300" dir="rtl">
                <Loader2 className="h-4 w-4 animate-spin" />
                מפעיל טרמינל…
              </div>
            </div>
          )}
        </div>

        <footer className="shrink-0 border-t border-slate-200 bg-white px-4 py-2.5 text-right">
          <div className="flex items-center justify-between gap-3 text-[11px]">
            <span className={status === 'failed' ? 'text-rose-600' : status === 'active' ? 'text-emerald-600' : 'text-slate-500'}>
              {statusMessage}
            </span>
            <span className="text-slate-400">המסוף עצמו פועל משמאל לימין</span>
          </div>
          {error && (
            <div className="mt-1 break-words text-xs text-rose-600">
              {error}
            </div>
          )}
        </footer>
      </section>
    </div>
  );
}
