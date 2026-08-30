import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Pause,
  Play,
  RefreshCw,
  X,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const SNAKE_COLS = 18;
const SNAKE_ROWS = 16;
const SNAKE_CELL = 20;
const SNAKE_GAME_WIDTH = SNAKE_COLS * SNAKE_CELL;
const SNAKE_GAME_HEIGHT = SNAKE_ROWS * SNAKE_CELL;

type SnakeDirection = 'up' | 'down' | 'left' | 'right';

interface SnakePoint {
  x: number;
  y: number;
}

interface SnakeBiomeDefinition {
  id: string;
  title: string;
  subtitle: string;
  goal: number;
  stepMs: number;
  backgroundTop: string;
  backgroundBottom: string;
  accentA: string;
  accentB: string;
  obstacleFill: string;
  obstacleStroke: string;
  foodFill: string;
  snakeHead: string;
  snakeBody: string;
  snakeBelly: string;
}

interface SnakeGameState {
  stageIndex: number;
  snake: SnakePoint[];
  direction: SnakeDirection;
  queuedDirection: SnakeDirection | null;
  food: SnakePoint;
  obstacles: SnakePoint[];
  eatenThisStage: number;
  totalScore: number;
  deaths: number;
  animTime: number;
}

const SNAKE_BIOMES: SnakeBiomeDefinition[] = [
  {
    id: 'snow',
    title: 'Glacier Run',
    subtitle: 'קרח, אדים ונשימה קפואה. כל תפוח כאן מרגיש כמו מרדף על שלג אמיתי.',
    goal: 7,
    stepMs: 175,
    backgroundTop: '#E0F2FE',
    backgroundBottom: '#F8FAFC',
    accentA: '#BAE6FD',
    accentB: '#CBD5E1',
    obstacleFill: '#E2E8F0',
    obstacleStroke: '#94A3B8',
    foodFill: '#F97316',
    snakeHead: '#0F766E',
    snakeBody: '#14B8A6',
    snakeBelly: '#CCFBF1',
  },
  {
    id: 'desert',
    title: 'Dune Relay',
    subtitle: 'מעברים בין קקטוסים ואבני חול. המסלול חם, הדופק מהיר יותר.',
    goal: 8,
    stepMs: 155,
    backgroundTop: '#FEF3C7',
    backgroundBottom: '#FED7AA',
    accentA: '#FDBA74',
    accentB: '#F59E0B',
    obstacleFill: '#D97706',
    obstacleStroke: '#92400E',
    foodFill: '#DC2626',
    snakeHead: '#166534',
    snakeBody: '#22C55E',
    snakeBelly: '#DCFCE7',
  },
  {
    id: 'rainforest',
    title: 'Canopy Drift',
    subtitle: 'עלים רטובים, שורשים וערפל ירוק. כאן צריך קווים נקיים ותיקונים חדים.',
    goal: 9,
    stepMs: 145,
    backgroundTop: '#DCFCE7',
    backgroundBottom: '#86EFAC',
    accentA: '#4ADE80',
    accentB: '#16A34A',
    obstacleFill: '#166534',
    obstacleStroke: '#14532D',
    foodFill: '#A855F7',
    snakeHead: '#1D4ED8',
    snakeBody: '#38BDF8',
    snakeBelly: '#E0F2FE',
  },
  {
    id: 'obsidian',
    title: 'Obsidian Flow',
    subtitle: 'זכוכית וולקנית, לבה כבויה ונתיבים צרים. השלב האחרון כבר לא סולח.',
    goal: 10,
    stepMs: 132,
    backgroundTop: '#1E1B4B',
    backgroundBottom: '#111827',
    accentA: '#7C3AED',
    accentB: '#F43F5E',
    obstacleFill: '#312E81',
    obstacleStroke: '#F97316',
    foodFill: '#FACC15',
    snakeHead: '#F97316',
    snakeBody: '#FB7185',
    snakeBelly: '#FDF2F8',
  },
];

function isSnakeOpposite(a: SnakeDirection, b: SnakeDirection) {
  return (
    (a === 'up' && b === 'down')
    || (a === 'down' && b === 'up')
    || (a === 'left' && b === 'right')
    || (a === 'right' && b === 'left')
  );
}

function snakePointKey(point: SnakePoint) {
  return `${point.x}:${point.y}`;
}

function createSnakeObstacleLayout(stageIndex: number) {
  const patterns = [
    [
      { x: 5, y: 4 }, { x: 6, y: 4 }, { x: 7, y: 4 },
      { x: 12, y: 10 }, { x: 12, y: 11 },
      { x: 3, y: 12 }, { x: 4, y: 12 }, { x: 5, y: 12 },
    ],
    [
      { x: 4, y: 3 }, { x: 4, y: 4 }, { x: 4, y: 5 },
      { x: 9, y: 8 }, { x: 10, y: 8 }, { x: 11, y: 8 },
      { x: 14, y: 4 }, { x: 14, y: 5 },
      { x: 7, y: 12 }, { x: 8, y: 12 }, { x: 9, y: 12 },
    ],
    [
      { x: 3, y: 3 }, { x: 4, y: 3 }, { x: 5, y: 3 },
      { x: 12, y: 5 }, { x: 12, y: 6 }, { x: 12, y: 7 },
      { x: 7, y: 10 }, { x: 8, y: 10 }, { x: 9, y: 10 }, { x: 10, y: 10 },
      { x: 2, y: 11 }, { x: 2, y: 12 },
    ],
    [
      { x: 5, y: 2 }, { x: 6, y: 2 }, { x: 7, y: 2 }, { x: 8, y: 2 },
      { x: 3, y: 7 }, { x: 4, y: 7 }, { x: 5, y: 7 },
      { x: 12, y: 7 }, { x: 13, y: 7 }, { x: 14, y: 7 },
      { x: 8, y: 12 }, { x: 8, y: 13 },
      { x: 11, y: 11 }, { x: 12, y: 11 },
    ],
  ];
  return patterns[stageIndex] || [];
}

function spawnSnakeFood(snake: SnakePoint[], obstacles: SnakePoint[]) {
  const blocked = new Set([
    ...snake.map(snakePointKey),
    ...obstacles.map(snakePointKey),
  ]);

  const openCells: SnakePoint[] = [];
  for (let y = 0; y < SNAKE_ROWS; y += 1) {
    for (let x = 0; x < SNAKE_COLS; x += 1) {
      if (!blocked.has(`${x}:${y}`)) {
        openCells.push({ x, y });
      }
    }
  }

  if (openCells.length === 0) {
    return { x: 0, y: 0 };
  }

  return openCells[Math.floor(Math.random() * openCells.length)];
}

function createSnakeGameState(stageIndex: number, totalScore = 0, deaths = 0): SnakeGameState {
  const obstacles = createSnakeObstacleLayout(stageIndex);
  const snake = [
    { x: 4, y: 8 },
    { x: 3, y: 8 },
    { x: 2, y: 8 },
  ];

  return {
    stageIndex,
    snake,
    direction: 'right',
    queuedDirection: null,
    food: spawnSnakeFood(snake, obstacles),
    obstacles,
    eatenThisStage: 0,
    totalScore,
    deaths,
    animTime: 0,
  };
}

function stepSnakeGame(state: SnakeGameState) {
  const direction = state.queuedDirection && !isSnakeOpposite(state.direction, state.queuedDirection)
    ? state.queuedDirection
    : state.direction;
  state.queuedDirection = null;
  state.direction = direction;

  const head = state.snake[0];
  const delta = (
    direction === 'up'
      ? { x: 0, y: -1 }
      : direction === 'down'
        ? { x: 0, y: 1 }
        : direction === 'left'
          ? { x: -1, y: 0 }
          : { x: 1, y: 0 }
  );

  const nextHead = {
    x: head.x + delta.x,
    y: head.y + delta.y,
  };

  if (
    nextHead.x < 0
    || nextHead.x >= SNAKE_COLS
    || nextHead.y < 0
    || nextHead.y >= SNAKE_ROWS
  ) {
    return { outcome: 'dead' as const, notice: 'הקיר עצר אותך.' };
  }

  if (state.obstacles.some((point) => point.x === nextHead.x && point.y === nextHead.y)) {
    return { outcome: 'dead' as const, notice: 'נכנסת ישר במכשול.' };
  }

  const willGrow = nextHead.x === state.food.x && nextHead.y === state.food.y;
  const snakeBody = willGrow ? state.snake : state.snake.slice(0, -1);
  if (snakeBody.some((segment) => segment.x === nextHead.x && segment.y === nextHead.y)) {
    return { outcome: 'dead' as const, notice: 'הזנב סגר על הראש.' };
  }

  state.snake = [nextHead, ...state.snake];

  if (willGrow) {
    state.eatenThisStage += 1;
    state.totalScore += 40 + state.stageIndex * 15;
    state.food = spawnSnakeFood(state.snake, state.obstacles);
    if (state.eatenThisStage >= SNAKE_BIOMES[state.stageIndex].goal) {
      state.totalScore += 120;
      return { outcome: 'cleared' as const, notice: 'הביום הושלם. השלב הבא נפתח.' };
    }
    return { outcome: 'ate' as const, notice: 'נאסף. תמשיך את השרשרת.' };
  }

  state.snake.pop();
  return { outcome: 'moved' as const };
}

function drawSnakeRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function drawSnakeGame(context: CanvasRenderingContext2D, state: SnakeGameState) {
  const biome = SNAKE_BIOMES[state.stageIndex];
  context.clearRect(0, 0, SNAKE_GAME_WIDTH, SNAKE_GAME_HEIGHT);

  const background = context.createLinearGradient(0, 0, 0, SNAKE_GAME_HEIGHT);
  background.addColorStop(0, biome.backgroundTop);
  background.addColorStop(1, biome.backgroundBottom);
  context.fillStyle = background;
  context.fillRect(0, 0, SNAKE_GAME_WIDTH, SNAKE_GAME_HEIGHT);

  const pulse = (Math.sin(state.animTime * 3.2) + 1) / 2;
  for (let y = 0; y < SNAKE_ROWS; y += 1) {
    for (let x = 0; x < SNAKE_COLS; x += 1) {
      const tileX = x * SNAKE_CELL;
      const tileY = y * SNAKE_CELL;
      context.fillStyle = (x + y) % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.04)';
      context.fillRect(tileX, tileY, SNAKE_CELL, SNAKE_CELL);
    }
  }

  context.save();
  context.globalAlpha = 0.45;
  for (let stripe = 0; stripe < 8; stripe += 1) {
    context.fillStyle = stripe % 2 === 0 ? biome.accentA : biome.accentB;
    context.beginPath();
    context.ellipse(
      (stripe / 8) * SNAKE_GAME_WIDTH + 18,
      26 + (stripe % 3) * 88,
      74,
      18,
      -0.35,
      0,
      Math.PI * 2
    );
    context.fill();
  }
  context.restore();

  state.obstacles.forEach((point, index) => {
    const x = point.x * SNAKE_CELL + 2;
    const y = point.y * SNAKE_CELL + 2;
    const gradient = context.createLinearGradient(x, y, x, y + SNAKE_CELL - 4);
    gradient.addColorStop(0, biome.obstacleFill);
    gradient.addColorStop(1, biome.obstacleStroke);
    drawSnakeRoundedRect(context, x, y, SNAKE_CELL - 4, SNAKE_CELL - 4, 7);
    context.fillStyle = gradient;
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,0.14)';
    context.stroke();

    context.fillStyle = 'rgba(255,255,255,0.18)';
    if (biome.id === 'snow') {
      context.beginPath();
      context.arc(x + 7, y + 7, 2, 0, Math.PI * 2);
      context.arc(x + 13, y + 11, 1.5, 0, Math.PI * 2);
      context.fill();
    } else if (biome.id === 'desert') {
      context.fillRect(x + 6, y + 5, 2, 12);
      context.fillRect(x + 12, y + 8, 2, 9);
    } else if (biome.id === 'rainforest') {
      context.beginPath();
      context.ellipse(x + 9, y + 9, 5, 8, 0.4, 0, Math.PI * 2);
      context.fill();
    } else if (index % 2 === 0) {
      context.fillRect(x + 5, y + 5, 8, 2);
      context.fillRect(x + 8, y + 9, 2, 7);
    }
  });

  const foodX = state.food.x * SNAKE_CELL + SNAKE_CELL / 2;
  const foodY = state.food.y * SNAKE_CELL + SNAKE_CELL / 2;
  const foodGlow = context.createRadialGradient(foodX, foodY, 2, foodX, foodY, 12 + pulse * 2);
  foodGlow.addColorStop(0, 'rgba(255,255,255,0.95)');
  foodGlow.addColorStop(0.28, biome.foodFill);
  foodGlow.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = foodGlow;
  context.beginPath();
  context.arc(foodX, foodY, 12 + pulse * 2, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = biome.foodFill;
  context.beginPath();
  context.arc(foodX, foodY, 5.5 + pulse * 0.7, 0, Math.PI * 2);
  context.fill();

  state.snake.slice().reverse().forEach((segment, indexFromTail) => {
    const segmentIndex = state.snake.length - 1 - indexFromTail;
    const drawX = segment.x * SNAKE_CELL + 2;
    const drawY = segment.y * SNAKE_CELL + 2;
    const isHead = segmentIndex === 0;
    const gradient = context.createLinearGradient(drawX, drawY, drawX, drawY + SNAKE_CELL - 4);
    gradient.addColorStop(0, isHead ? biome.snakeHead : biome.snakeBody);
    gradient.addColorStop(1, biome.snakeBody);
    drawSnakeRoundedRect(context, drawX, drawY, SNAKE_CELL - 4, SNAKE_CELL - 4, 8);
    context.fillStyle = gradient;
    context.fill();

    context.fillStyle = biome.snakeBelly;
    drawSnakeRoundedRect(context, drawX + 4, drawY + 7, SNAKE_CELL - 12, SNAKE_CELL - 13, 4);
    context.fill();

    context.fillStyle = 'rgba(255,255,255,0.28)';
    context.fillRect(drawX + 4, drawY + 3, SNAKE_CELL - 12, 2);

    if (isHead) {
      context.fillStyle = '#F8FAFC';
      context.beginPath();
      context.arc(drawX + 8, drawY + 8, 2.2, 0, Math.PI * 2);
      context.arc(drawX + 14, drawY + 8, 2.2, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = '#0F172A';
      context.beginPath();
      context.arc(drawX + 8, drawY + 8, 0.9, 0, Math.PI * 2);
      context.arc(drawX + 14, drawY + 8, 0.9, 0, Math.PI * 2);
      context.fill();
    }
  });
}

export function BiomeSnakeDialog({
  isOpen,
  onClose,
  sessionActiveCount,
  sessionCompletionSignal,
}: {
  isOpen: boolean;
  onClose: () => void;
  sessionActiveCount: number;
  sessionCompletionSignal: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const accumulatorRef = useRef(0);
  const lastFrameRef = useRef<number | null>(null);
  const stateRef = useRef<SnakeGameState>(createSnakeGameState(0));
  const noticeTimerRef = useRef<number | null>(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [eatenThisStage, setEatenThisStage] = useState(0);
  const [deaths, setDeaths] = useState(0);
  const [topStatus, setTopStatus] = useState('Biome Snake');
  const [notice, setNotice] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isStageCleared, setIsStageCleared] = useState(false);
  const [isCampaignComplete, setIsCampaignComplete] = useState(false);

  const currentBiome = useMemo(() => SNAKE_BIOMES[stageIndex], [stageIndex]);

  const syncHud = useEffectEvent(() => {
    const snapshot = stateRef.current;
    setStageIndex(snapshot.stageIndex);
    setScore(snapshot.totalScore);
    setEatenThisStage(snapshot.eatenThisStage);
    setDeaths(snapshot.deaths);
  });

  const showNotice = useEffectEvent((message: string | null) => {
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setNotice(message);
    if (message) {
      noticeTimerRef.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimerRef.current = null;
      }, 2200);
    }
  });

  const loadStage = useEffectEvent((nextStageIndex: number, totalScore = 0, deathsCount = 0) => {
    stateRef.current = createSnakeGameState(nextStageIndex, totalScore, deathsCount);
    accumulatorRef.current = 0;
    lastFrameRef.current = null;
    setIsPaused(false);
    setIsGameOver(false);
    setIsStageCleared(false);
    setIsCampaignComplete(false);
    setTopStatus(sessionActiveCount > 0 ? 'הסשן רץ ברקע' : SNAKE_BIOMES[nextStageIndex].title);
    showNotice(SNAKE_BIOMES[nextStageIndex].subtitle);
    syncHud();
  });

  const resetStage = useEffectEvent(() => {
    const snapshot = stateRef.current;
    loadStage(snapshot.stageIndex, snapshot.totalScore, snapshot.deaths);
  });

  const restartCampaign = useEffectEvent(() => {
    loadStage(0, 0, 0);
  });

  const queueDirection = useEffectEvent((direction: SnakeDirection) => {
    if (isPaused || isGameOver || isStageCleared || isCampaignComplete) {
      return;
    }
    if (isSnakeOpposite(stateRef.current.direction, direction)) {
      return;
    }
    stateRef.current.queuedDirection = direction;
  });

  const advanceStage = useEffectEvent(() => {
    const snapshot = stateRef.current;
    if (snapshot.stageIndex >= SNAKE_BIOMES.length - 1) {
      setIsStageCleared(false);
      setIsCampaignComplete(true);
      setTopStatus('כל הביומים הושלמו');
      showNotice('סגרת את כל המסלול. אפשר להתחיל קמפיין חדש.');
      syncHud();
      return;
    }
    loadStage(snapshot.stageIndex + 1, snapshot.totalScore + 80, snapshot.deaths);
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    loadStage(0, 0, 0);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') {
        event.preventDefault();
        queueDirection('up');
      } else if (event.key === 'ArrowDown' || event.key === 's' || event.key === 'S') {
        event.preventDefault();
        queueDirection('down');
      } else if (event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        queueDirection('left');
      } else if (event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D') {
        event.preventDefault();
        queueDirection('right');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (sessionActiveCount > 0) {
      setTopStatus('הסשן רץ ברקע');
      return;
    }
    if (!isGameOver && !isStageCleared && !isCampaignComplete) {
      setTopStatus(SNAKE_BIOMES[stateRef.current.stageIndex].title);
    }
  }, [isCampaignComplete, isGameOver, isOpen, isStageCleared, sessionActiveCount]);

  useEffect(() => {
    if (!isOpen || sessionCompletionSignal === 0) {
      return;
    }
    setTopStatus('הסשן הושלם');
    showNotice('הסשן הושלם ברקע. אפשר להמשיך לשלב הבא או לחזור לצ׳אט.');
  }, [isOpen, sessionCompletionSignal]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }

    const render = (frameTime: number) => {
      animationRef.current = window.requestAnimationFrame(render);
      const lastFrame = lastFrameRef.current ?? frameTime;
      const dt = Math.min(0.05, (frameTime - lastFrame) / 1000);
      lastFrameRef.current = frameTime;
      stateRef.current.animTime = frameTime / 1000;

      if (!isPaused && !isGameOver && !isStageCleared && !isCampaignComplete) {
        accumulatorRef.current += dt * 1000;
        const stepMs = SNAKE_BIOMES[stateRef.current.stageIndex].stepMs;
        while (accumulatorRef.current >= stepMs) {
          accumulatorRef.current -= stepMs;
          const result = stepSnakeGame(stateRef.current);
          if (result.notice) {
            showNotice(result.notice);
          }
          syncHud();

          if (result.outcome === 'dead') {
            stateRef.current.deaths += 1;
            setIsGameOver(true);
            setTopStatus('המסלול נסגר');
            syncHud();
            break;
          }

          if (result.outcome === 'cleared') {
            setIsStageCleared(true);
            setTopStatus('הביום הושלם');
            syncHud();
            break;
          }
        }
      }

      drawSnakeGame(context, stateRef.current);
    };

    animationRef.current = window.requestAnimationFrame(render);
    return () => {
      if (animationRef.current) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isCampaignComplete, isGameOver, isOpen, isPaused, isStageCleared]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[77] flex items-end justify-center bg-slate-950/30 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close biome snake"
      />
      <div className="relative z-10 flex max-h-[90dvh] w-full max-w-sm flex-col overflow-y-auto rounded-[2rem] border border-sky-100 bg-white text-slate-800 shadow-[0_30px_100px_-40px_rgba(59,130,246,0.35)]">
        <div className="border-b border-sky-100 bg-gradient-to-b from-sky-50 via-cyan-50 to-white px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-sky-600 shadow-sm"
              title={topStatus}
            >
              <Zap className="h-5 w-5" />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsPaused((current) => !current)}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-sky-50"
              >
                {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => resetStage()}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-sky-50"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-sky-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-3 text-right">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Biome Snake
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <div className="text-lg font-semibold text-slate-800">{currentBiome.title}</div>
              <span className="rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-sky-700 shadow-sm">
                שלב {stageIndex + 1}/{SNAKE_BIOMES.length}
              </span>
            </div>
            <div className="mt-1 text-xs leading-5 text-slate-500">{currentBiome.subtitle}</div>
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2 text-xs">
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Score</div>
              <div className="mt-1 text-base font-semibold">{score}</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Stage</div>
              <div className="mt-1 text-base font-semibold">
                {eatenThisStage}/{currentBiome.goal}
              </div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Speed</div>
              <div className="mt-1 text-base font-semibold">{Math.round(1000 / currentBiome.stepMs)}</div>
            </div>
            <div className={cn('rounded-2xl bg-white px-3 py-2', deaths > 0 && 'bg-rose-50 text-rose-700')}>
              <div className={cn('text-slate-400', deaths > 0 && 'text-rose-500')}>Fails</div>
              <div className="mt-1 text-base font-semibold">{deaths}</div>
            </div>
          </div>
        </div>

        <div className="relative px-4 pb-4 pt-4">
          <canvas
            ref={canvasRef}
            width={SNAKE_GAME_WIDTH}
            height={SNAKE_GAME_HEIGHT}
            className="aspect-[360/320] h-auto max-h-[46dvh] w-full rounded-[1.5rem] border border-white/20 bg-slate-900"
          />
          {notice && (
            <div className="pointer-events-none absolute left-8 right-8 top-8 rounded-full bg-sky-400/95 px-4 py-2 text-center text-sm font-semibold text-slate-950 shadow-lg">
              {notice}
            </div>
          )}
          {(isGameOver || isStageCleared || isCampaignComplete) && (
            <div className="absolute inset-8 flex items-center justify-center rounded-[1.5rem] bg-slate-950/60 backdrop-blur-sm">
              <div className="w-full max-w-[16rem] text-center text-white">
                <div className="text-xl font-bold">
                  {isCampaignComplete
                    ? 'כל הביומים הושלמו'
                    : isStageCleared
                      ? 'השלב הושלם'
                      : 'הסנייק נחתך'}
                </div>
                <div className="mt-2 text-sm leading-6 text-slate-200">
                  {isCampaignComplete
                    ? 'עברת את השלג, המדבר, הג׳ונגל והאובסידיאן. אפשר להתחיל שוב עם קו מושלם יותר.'
                    : isStageCleared
                      ? 'היעד של הביום הזה נסגר. לחץ כדי לעבור לרקע הבא.'
                      : 'אפשר להפעיל מחדש את אותו שלב או לאפס את כל הקמפיין.'}
                </div>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {isStageCleared && !isCampaignComplete && (
                    <button
                      type="button"
                      onClick={() => advanceStage()}
                      className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300"
                    >
                      שלב הבא
                    </button>
                  )}
                  {isCampaignComplete && (
                    <button
                      type="button"
                      onClick={() => restartCampaign()}
                      className="rounded-full bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300"
                    >
                      קמפיין חדש
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => resetStage()}
                    className="rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
                  >
                    נסה שוב
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-3 border-t border-sky-100 bg-gradient-to-b from-white to-sky-50/40 px-4 pb-4 pt-3">
          <div dir="ltr" className="mx-auto grid w-full max-w-[12rem] grid-cols-3 gap-2">
            <div />
            <button
              type="button"
              onClick={() => queueDirection('up')}
              className="flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-sky-50"
            >
              <ChevronUp className="h-5 w-5" />
            </button>
            <div />
            <button
              type="button"
              onClick={() => queueDirection('left')}
              className="flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-sky-50"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => queueDirection('down')}
              className="flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-sky-50"
            >
              <ChevronDown className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => queueDirection('right')}
              className="flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-sky-50"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
            <span dir="rtl">{topStatus}</span>
            <span className="shrink-0">יעד השלב: {currentBiome.goal}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
