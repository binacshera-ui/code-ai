import { useEffect, useEffectEvent, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const VAULT_COLS = 11;
const VAULT_ROWS = 10;
const VAULT_CELL = 28;
const VAULT_WIDTH = VAULT_COLS * VAULT_CELL;
const VAULT_HEIGHT = VAULT_ROWS * VAULT_CELL;

type VaultDirection = 'up' | 'down' | 'left' | 'right';
type VaultTile = 'wall' | 'floor' | 'data' | 'key' | 'door' | 'exit' | 'laser';

interface VaultCamera {
  id: number;
  x: number;
  y: number;
  directions: VaultDirection[];
  speed: number;
}

interface VaultLevelDefinition {
  id: string;
  title: string;
  subtitle: string;
  top: string;
  bottom: string;
  accent: string;
  map: string[];
  cameras: VaultCamera[];
}

interface VaultState {
  levelIndex: number;
  grid: VaultTile[][];
  playerX: number;
  playerY: number;
  hasKey: boolean;
  collected: number;
  totalData: number;
  alerts: number;
  steps: number;
  time: number;
}

interface VaultMoveResult {
  moved: boolean;
  status: string;
  outcome: 'ok' | 'blocked' | 'alert' | 'cleared';
}

const VAULT_LEVELS: VaultLevelDefinition[] = [
  {
    id: 'neon-entry',
    title: 'Neon Entry',
    subtitle: 'הכניסה מהירה, אבל הלייזרים מלמדים מהר שלא כל מסדרון פתוח באמת.',
    top: '#E0F2FE',
    bottom: '#EEF2FF',
    accent: '#38BDF8',
    map: [
      '###########',
      '#P..L..*.E#',
      '#.##.#.##.#',
      '#....#....#',
      '#.##.D.##.#',
      '#..*...#..#',
      '#.####.#k.#',
      '#......#..#',
      '#..L..*...#',
      '###########',
    ],
    cameras: [
      { id: 1, x: 5, y: 3, directions: ['left', 'down', 'right'], speed: 0.9 },
      { id: 2, x: 8, y: 7, directions: ['up', 'left'], speed: 1.25 },
    ],
  },
  {
    id: 'mirror-corridor',
    title: 'Mirror Corridor',
    subtitle: 'מצלמות חותכות מסדרונות כפולים. מפתח אחד פותח הכול, אם נשארת חי.',
    top: '#ECFCCB',
    bottom: '#DCFCE7',
    accent: '#22C55E',
    map: [
      '###########',
      '#P..#..*.E#',
      '#.#.#.##..#',
      '#.#...L.#.#',
      '#.###D#.#.#',
      '#...#.#...#',
      '#.L.#.###.#',
      '#..*..#k..#',
      '#.#####...#',
      '###########',
    ],
    cameras: [
      { id: 1, x: 3, y: 2, directions: ['down', 'right'], speed: 1.05 },
      { id: 2, x: 7, y: 5, directions: ['left', 'up', 'right'], speed: 1.18 },
    ],
  },
  {
    id: 'black-ice',
    title: 'Black Ice',
    subtitle: 'המסלול נראה נקי, אבל שלושה עיניים ושלוש מלכודות חותכות כל פינה.',
    top: '#EDE9FE',
    bottom: '#FDF2F8',
    accent: '#A855F7',
    map: [
      '###########',
      '#P..L#..*.#',
      '#.#..#.#..#',
      '#.#.##.#E.#',
      '#...D..#..#',
      '###.###.#.#',
      '#k..#..L#.#',
      '#.##.#..*.#',
      '#....#....#',
      '###########',
    ],
    cameras: [
      { id: 1, x: 5, y: 1, directions: ['down', 'left'], speed: 1.1 },
      { id: 2, x: 2, y: 8, directions: ['up', 'right'], speed: 1.4 },
      { id: 3, x: 8, y: 6, directions: ['up', 'left'], speed: 1.22 },
    ],
  },
  {
    id: 'crown-vault',
    title: 'Crown Vault',
    subtitle: 'החדר האחרון כבר לא סולח. הכל צפוף, הכל נצפה, הכל נעול.',
    top: '#1E293B',
    bottom: '#0F172A',
    accent: '#F59E0B',
    map: [
      '###########',
      '#P.*L#..E.#',
      '#.#.#.#.#.#',
      '#.#...#.#.#',
      '#.###D#.#.#',
      '#..L#.#..*#',
      '###.#.###.#',
      '#k..#....##',
      '#..*..L...#',
      '###########',
    ],
    cameras: [
      { id: 1, x: 1, y: 5, directions: ['right', 'up'], speed: 1.2 },
      { id: 2, x: 7, y: 1, directions: ['down', 'left', 'right'], speed: 1.35 },
      { id: 3, x: 8, y: 8, directions: ['up', 'left'], speed: 1.5 },
    ],
  },
];

function drawRoundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const safeRadius = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2));
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function createVaultState(levelIndex: number, alerts = 0): VaultState {
  const level = VAULT_LEVELS[levelIndex];
  const grid: VaultTile[][] = [];
  let playerX = 1;
  let playerY = 1;
  let totalData = 0;

  level.map.forEach((row, y) => {
    const nextRow: VaultTile[] = [];
    row.split('').forEach((char, x) => {
      if (char === 'P') {
        playerX = x;
        playerY = y;
        nextRow.push('floor');
        return;
      }
      const tile: VaultTile = (
        char === '#'
          ? 'wall'
          : char === '*'
            ? 'data'
            : char === 'k'
              ? 'key'
              : char === 'D'
                ? 'door'
                : char === 'E'
                  ? 'exit'
                  : char === 'L'
                    ? 'laser'
                    : 'floor'
      );
      if (tile === 'data') {
        totalData += 1;
      }
      nextRow.push(tile);
    });
    grid.push(nextRow);
  });

  return {
    levelIndex,
    grid,
    playerX,
    playerY,
    hasKey: false,
    collected: 0,
    totalData,
    alerts,
    steps: 0,
    time: 0,
  };
}

function isInsideVault(x: number, y: number) {
  return x >= 0 && x < VAULT_COLS && y >= 0 && y < VAULT_ROWS;
}

function getVaultTile(state: VaultState, x: number, y: number): VaultTile {
  if (!isInsideVault(x, y)) {
    return 'wall';
  }
  return state.grid[y][x];
}

function setVaultTile(state: VaultState, x: number, y: number, tile: VaultTile) {
  if (!isInsideVault(x, y)) {
    return;
  }
  state.grid[y][x] = tile;
}

function getCameraDirection(camera: VaultCamera, time: number): VaultDirection {
  const index = Math.floor(time * camera.speed) % camera.directions.length;
  return camera.directions[index];
}

function isLaserActive(time: number, x: number, y: number) {
  return Math.floor((time + x * 0.18 + y * 0.12) * 1.4) % 2 === 0;
}

function hasWallBetween(state: VaultState, startX: number, startY: number, endX: number, endY: number) {
  if (startX === endX) {
    const [from, to] = startY < endY ? [startY + 1, endY] : [endY + 1, startY];
    for (let y = from; y < to; y += 1) {
      if (getVaultTile(state, startX, y) === 'wall') {
        return true;
      }
    }
    return false;
  }
  if (startY === endY) {
    const [from, to] = startX < endX ? [startX + 1, endX] : [endX + 1, startX];
    for (let x = from; x < to; x += 1) {
      if (getVaultTile(state, x, startY) === 'wall') {
        return true;
      }
    }
    return false;
  }
  return true;
}

function detectVaultAlert(state: VaultState, level: VaultLevelDefinition) {
  const tile = getVaultTile(state, state.playerX, state.playerY);
  if (tile === 'laser' && isLaserActive(state.time, state.playerX, state.playerY)) {
    return 'הלייזר בדיוק היה פתוח.';
  }

  for (const camera of level.cameras) {
    const direction = getCameraDirection(camera, state.time);
    if (direction === 'up' && state.playerX === camera.x && state.playerY < camera.y && !hasWallBetween(state, camera.x, camera.y, state.playerX, state.playerY)) {
      return 'נכנסת ישר לקונוס של מצלמה.';
    }
    if (direction === 'down' && state.playerX === camera.x && state.playerY > camera.y && !hasWallBetween(state, camera.x, camera.y, state.playerX, state.playerY)) {
      return 'נכנסת ישר לקונוס של מצלמה.';
    }
    if (direction === 'left' && state.playerY === camera.y && state.playerX < camera.x && !hasWallBetween(state, camera.x, camera.y, state.playerX, state.playerY)) {
      return 'נכנסת ישר לקונוס של מצלמה.';
    }
    if (direction === 'right' && state.playerY === camera.y && state.playerX > camera.x && !hasWallBetween(state, camera.x, camera.y, state.playerX, state.playerY)) {
      return 'נכנסת ישר לקונוס של מצלמה.';
    }
  }
  return null;
}

function moveVault(state: VaultState, level: VaultLevelDefinition, direction: VaultDirection): VaultMoveResult {
  const delta = (
    direction === 'up'
      ? { x: 0, y: -1 }
      : direction === 'down'
        ? { x: 0, y: 1 }
        : direction === 'left'
          ? { x: -1, y: 0 }
          : { x: 1, y: 0 }
  );

  const nextX = state.playerX + delta.x;
  const nextY = state.playerY + delta.y;
  const nextTile = getVaultTile(state, nextX, nextY);

  if (nextTile === 'wall') {
    return { moved: false, status: 'הקיר הזה סגור לגמרי.', outcome: 'blocked' };
  }
  if (nextTile === 'door' && !state.hasKey) {
    return { moved: false, status: 'הדלת מחכה לכרטיס.', outcome: 'blocked' };
  }

  state.playerX = nextX;
  state.playerY = nextY;
  state.steps += 1;

  if (nextTile === 'data') {
    state.collected += 1;
    setVaultTile(state, nextX, nextY, 'floor');
  }
  if (nextTile === 'key') {
    state.hasKey = true;
    setVaultTile(state, nextX, nextY, 'floor');
  }
  if (nextTile === 'door' && state.hasKey) {
    setVaultTile(state, nextX, nextY, 'floor');
  }

  const alert = detectVaultAlert(state, level);
  if (alert) {
    state.alerts += 1;
    return { moved: true, status: alert, outcome: 'alert' };
  }

  if (nextTile === 'exit') {
    if (state.collected < state.totalData) {
      return { moved: true, status: 'עוד לא אספת את כל הליבות.', outcome: 'blocked' };
    }
    if (!state.hasKey) {
      return { moved: true, status: 'היציאה הזאת עדיין נעולה לכרטיס.', outcome: 'blocked' };
    }
    return { moved: true, status: 'השלב נפרץ עד הסוף.', outcome: 'cleared' };
  }

  return { moved: true, status: 'תזוזה נקייה. המשך לשכבה הבאה.', outcome: 'ok' };
}

function drawVaultBackground(context: CanvasRenderingContext2D, level: VaultLevelDefinition) {
  const gradient = context.createLinearGradient(0, 0, 0, VAULT_HEIGHT);
  gradient.addColorStop(0, level.top);
  gradient.addColorStop(1, level.bottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, VAULT_WIDTH, VAULT_HEIGHT);
}

function drawCameraCone(context: CanvasRenderingContext2D, camera: VaultCamera, direction: VaultDirection, accent: string) {
  const centerX = camera.x * VAULT_CELL + VAULT_CELL / 2;
  const centerY = camera.y * VAULT_CELL + VAULT_CELL / 2;
  context.save();
  context.fillStyle = `${accent}20`;
  context.beginPath();
  context.moveTo(centerX, centerY);
  if (direction === 'up') {
    context.lineTo(centerX - 54, centerY - 94);
    context.lineTo(centerX + 54, centerY - 94);
  } else if (direction === 'down') {
    context.lineTo(centerX - 54, centerY + 94);
    context.lineTo(centerX + 54, centerY + 94);
  } else if (direction === 'left') {
    context.lineTo(centerX - 94, centerY - 54);
    context.lineTo(centerX - 94, centerY + 54);
  } else {
    context.lineTo(centerX + 94, centerY - 54);
    context.lineTo(centerX + 94, centerY + 54);
  }
  context.closePath();
  context.fill();
  context.restore();
}

function drawVaultState(context: CanvasRenderingContext2D, state: VaultState, level: VaultLevelDefinition) {
  drawVaultBackground(context, level);

  level.cameras.forEach((camera) => drawCameraCone(context, camera, getCameraDirection(camera, state.time), level.accent));

  for (let y = 0; y < VAULT_ROWS; y += 1) {
    for (let x = 0; x < VAULT_COLS; x += 1) {
      const tile = state.grid[y][x];
      const cellX = x * VAULT_CELL;
      const cellY = y * VAULT_CELL;

      context.fillStyle = tile === 'wall' ? '#0F172A' : 'rgba(255,255,255,0.7)';
      context.fillRect(cellX + 1, cellY + 1, VAULT_CELL - 2, VAULT_CELL - 2);

      if (tile === 'wall') {
        context.fillStyle = 'rgba(255,255,255,0.08)';
        context.fillRect(cellX + 4, cellY + 4, VAULT_CELL - 8, 6);
      }

      if (tile === 'data') {
        context.fillStyle = level.accent;
        drawRoundedRectPath(context, cellX + 9, cellY + 7, 10, 14, 4);
        context.fill();
      }

      if (tile === 'key') {
        context.fillStyle = '#F59E0B';
        context.beginPath();
        context.arc(cellX + 11, cellY + 14, 5, 0, Math.PI * 2);
        context.fill();
        context.fillRect(cellX + 14, cellY + 13, 8, 3);
      }

      if (tile === 'door') {
        context.fillStyle = '#1D4ED8';
        drawRoundedRectPath(context, cellX + 7, cellY + 4, 14, 20, 4);
        context.fill();
      }

      if (tile === 'exit') {
        context.strokeStyle = '#10B981';
        context.lineWidth = 3;
        drawRoundedRectPath(context, cellX + 4, cellY + 4, 20, 20, 6);
        context.stroke();
      }

      if (tile === 'laser' && isLaserActive(state.time, x, y)) {
        context.fillStyle = '#FB7185';
        context.fillRect(cellX + 4, cellY + 12, 20, 4);
      }
    }
  }

  level.cameras.forEach((camera) => {
    const x = camera.x * VAULT_CELL + VAULT_CELL / 2;
    const y = camera.y * VAULT_CELL + VAULT_CELL / 2;
    context.fillStyle = '#0F172A';
    context.beginPath();
    context.arc(x, y, 8, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = level.accent;
    context.beginPath();
    context.arc(x, y, 3.2, 0, Math.PI * 2);
    context.fill();
  });

  const playerCenterX = state.playerX * VAULT_CELL + VAULT_CELL / 2;
  const playerCenterY = state.playerY * VAULT_CELL + VAULT_CELL / 2;
  context.fillStyle = '#0F766E';
  drawRoundedRectPath(context, playerCenterX - 9, playerCenterY - 9, 18, 18, 6);
  context.fill();
  context.fillStyle = '#CCFBF1';
  context.beginPath();
  context.arc(playerCenterX + 3, playerCenterY - 3, 3, 0, Math.PI * 2);
  context.fill();
}

export function VaultRunnerDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const stateRef = useRef<VaultState>(createVaultState(0));
  const [levelIndex, setLevelIndex] = useState(0);
  const [collected, setCollected] = useState(0);
  const [totalData, setTotalData] = useState(0);
  const [hasKey, setHasKey] = useState(false);
  const [alerts, setAlerts] = useState(0);
  const [steps, setSteps] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isCampaignComplete, setIsCampaignComplete] = useState(false);

  const level = useMemo(() => VAULT_LEVELS[levelIndex] ?? VAULT_LEVELS[0], [levelIndex]);

  const syncHud = useEffectEvent(() => {
    const snapshot = stateRef.current;
    setLevelIndex(snapshot.levelIndex);
    setCollected(snapshot.collected);
    setTotalData(snapshot.totalData);
    setHasKey(snapshot.hasKey);
    setAlerts(snapshot.alerts);
    setSteps(snapshot.steps);
  });

  const resetCampaign = useEffectEvent(() => {
    stateRef.current = createVaultState(0);
    setNotice(null);
    setIsPaused(false);
    setIsGameOver(false);
    setIsCampaignComplete(false);
    syncHud();
  });

  const advanceLevel = useEffectEvent(() => {
    const snapshot = stateRef.current;
    if (snapshot.levelIndex >= VAULT_LEVELS.length - 1) {
      setIsCampaignComplete(true);
      setNotice('כל הכספת נפתחה. אין עוד מה לנעול מולך.');
      return;
    }
    stateRef.current = createVaultState(snapshot.levelIndex + 1, snapshot.alerts);
    setIsPaused(false);
    setIsGameOver(false);
    setNotice(`נכנסת ל-${VAULT_LEVELS[snapshot.levelIndex + 1].title}`);
    syncHud();
  });

  const redraw = useEffectEvent(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    drawVaultState(context, stateRef.current, level);
  });

  const performMove = useEffectEvent((direction: VaultDirection) => {
    if (isPaused || isGameOver || isCampaignComplete) {
      return;
    }
    const snapshot = stateRef.current;
    const moveResult = moveVault(snapshot, VAULT_LEVELS[snapshot.levelIndex], direction);
    setNotice(moveResult.status);
    if (moveResult.outcome === 'alert') {
      setIsGameOver(true);
    }
    if (moveResult.outcome === 'cleared') {
      setIsPaused(true);
    }
    syncHud();
    redraw();
  });

  const animate = useEffectEvent((timestamp: number) => {
    if (!isOpen) {
      return;
    }
    const snapshot = stateRef.current;
    if (!isPaused && !isGameOver && !isCampaignComplete) {
      snapshot.time = timestamp / 1000;
    }
    redraw();
    animationRef.current = window.requestAnimationFrame(animate);
  });

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    resetCampaign();
    redraw();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        event.preventDefault();
        setIsPaused((current) => !current);
        return;
      }
      if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'w') performMove('up');
      if (event.key === 'ArrowDown' || event.key.toLowerCase() === 's') performMove('down');
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') performMove('left');
      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') performMove('right');
    };
    window.addEventListener('keydown', onKeyDown);
    animationRef.current = window.requestAnimationFrame(animate);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (animationRef.current) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const triggerMove = (direction: VaultDirection) => {
    performMove(direction);
  };

  const handleMovePointerDown = (direction: VaultDirection, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    triggerMove(direction);
  };

  const handleMoveTouchStart = (direction: VaultDirection, event: ReactTouchEvent<HTMLButtonElement>) => {
    event.preventDefault();
    triggerMove(direction);
  };

  return (
    <div className="fixed inset-0 z-[77] flex items-end justify-center bg-slate-950/30 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close Vault Runner"
      />
      <div className="relative z-10 flex max-h-[90dvh] w-full max-w-xl flex-col overflow-y-auto rounded-[2rem] border border-slate-100 bg-white shadow-[0_34px_100px_-38px_rgba(15,23,42,0.45)]">
        <div className="border-b border-slate-100 bg-gradient-to-b from-sky-50/70 via-white to-white px-5 py-4 text-right">
          <div className="flex items-start justify-between gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[1.25rem] bg-gradient-to-br from-sky-100 via-white to-violet-100 text-sky-600 shadow-sm">
              <Eye className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Premium Arcade
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-800">Vault Runner</div>
              <div className="mt-1 text-sm leading-6 text-slate-500">{level.subtitle}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-slate-50 p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-4 p-4">
          <div className="grid grid-cols-4 gap-2 text-right">
            <div className="rounded-[1.1rem] border border-slate-100 bg-slate-50/85 px-3 py-2">
              <div className="text-[10px] text-slate-400">שלב</div>
              <div className="mt-1 text-sm font-semibold text-slate-800">{level.title}</div>
            </div>
            <div className="rounded-[1.1rem] border border-sky-100 bg-sky-50/80 px-3 py-2">
              <div className="text-[10px] text-sky-500">ליבות</div>
              <div className="mt-1 text-sm font-semibold text-sky-700">{collected} / {totalData}</div>
            </div>
            <div className="rounded-[1.1rem] border border-amber-100 bg-amber-50/80 px-3 py-2">
              <div className="text-[10px] text-amber-500">כרטיס</div>
              <div className="mt-1 text-sm font-semibold text-amber-700">{hasKey ? 'כן' : 'לא'}</div>
            </div>
            <div className="rounded-[1.1rem] border border-rose-100 bg-rose-50/80 px-3 py-2">
              <div className="text-[10px] text-rose-500">התראות</div>
              <div className="mt-1 text-sm font-semibold text-rose-700">{alerts}</div>
            </div>
          </div>

          <div className="overflow-hidden rounded-[1.75rem] border border-slate-100 bg-slate-950 shadow-[0_26px_72px_-36px_rgba(15,23,42,0.56)]">
            <canvas
              ref={canvasRef}
              width={VAULT_WIDTH}
              height={VAULT_HEIGHT}
              className="block h-auto w-full touch-none bg-slate-950"
            />
          </div>

          <div className="rounded-[1.35rem] border border-slate-100 bg-white/90 px-4 py-3 shadow-[0_20px_50px_-40px_rgba(15,23,42,0.32)]">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{level.title}</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">
                  {notice ?? 'אסוף את כל הליבות, קח את הכרטיס, וחתוך החוצה בלי לגעת בלייזרים או בעיני המצלמות.'}
                </div>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                צעדים {steps}
              </div>
            </div>
          </div>

          <div dir="ltr" className="mx-auto grid w-[12rem] grid-cols-3 gap-2">
            <div />
            <button
              type="button"
              onPointerDown={(event) => handleMovePointerDown('up', event)}
              onTouchStart={(event) => handleMoveTouchStart('up', event)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  triggerMove('up');
                }
              }}
              className="flex h-11 touch-none items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <div />
            <button
              type="button"
              onPointerDown={(event) => handleMovePointerDown('left', event)}
              onTouchStart={(event) => handleMoveTouchStart('left', event)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  triggerMove('left');
                }
              }}
              className="flex h-11 touch-none items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setIsPaused((current) => !current)}
              className="flex h-11 items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            >
              {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onPointerDown={(event) => handleMovePointerDown('right', event)}
              onTouchStart={(event) => handleMoveTouchStart('right', event)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  triggerMove('right');
                }
              }}
              className="flex h-11 touch-none items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div />
            <button
              type="button"
              onPointerDown={(event) => handleMovePointerDown('down', event)}
              onTouchStart={(event) => handleMoveTouchStart('down', event)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  triggerMove('down');
                }
              }}
              className="flex h-11 touch-none items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => resetCampaign()}
              className="flex h-11 items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>

          <div className="flex items-center justify-end gap-2">
            {isPaused && !isGameOver && !isCampaignComplete && collected >= totalData && hasKey && (
              <button
                type="button"
                onClick={() => advanceLevel()}
                className="rounded-full bg-gradient-to-r from-sky-100 via-violet-100 to-cyan-100 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:from-sky-200 hover:to-cyan-200"
              >
                לכספת הבאה
              </button>
            )}
            {(isGameOver || isCampaignComplete) && (
              <button
                type="button"
                onClick={() => resetCampaign()}
                className="rounded-full bg-gradient-to-r from-rose-100 via-amber-100 to-cyan-100 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:from-rose-200 hover:to-cyan-200"
              >
                קמפיין חדש
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
