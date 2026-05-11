import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const TANK_WIDTH = 360;
const TANK_HEIGHT = 248;

type TankDirection = 'up' | 'down' | 'left' | 'right';

interface TankObstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DesertStageDefinition {
  id: string;
  title: string;
  subtitle: string;
  accent: string;
  skyTop: string;
  skyBottom: string;
  terrainA: string;
  terrainB: string;
  dust: string;
  obstacleFill: string;
  obstacleStroke: string;
  waves: number[];
  enemySpeed: number;
  enemyFireMs: number;
  obstacles: TankObstacle[];
}

interface DesertTank {
  id: number;
  x: number;
  y: number;
  dir: TankDirection;
  health: number;
  fireCooldown: number;
  moveJitter: number;
}

interface DesertProjectile {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  owner: 'player' | 'enemy';
  life: number;
}

interface DesertBurst {
  id: number;
  x: number;
  y: number;
  life: number;
  color: string;
}

interface DesertPlayer {
  x: number;
  y: number;
  dir: TankDirection;
  health: number;
  fireCooldown: number;
  invulnerability: number;
}

interface DesertGameState {
  stageIndex: number;
  waveIndex: number;
  player: DesertPlayer;
  enemies: DesertTank[];
  projectiles: DesertProjectile[];
  bursts: DesertBurst[];
  score: number;
  scrap: number;
  defeats: number;
  time: number;
  nextEnemyId: number;
  nextProjectileId: number;
  nextBurstId: number;
}

const DESERT_STAGES: DesertStageDefinition[] = [
  {
    id: 'gold-run',
    title: 'Gold Run',
    subtitle: 'חול דק, קו ראייה פתוח, והגל הראשון של השריון כבר בדרך.',
    accent: '#F59E0B',
    skyTop: '#FDE68A',
    skyBottom: '#FFFBEB',
    terrainA: '#FCD34D',
    terrainB: '#F59E0B',
    dust: 'rgba(245,158,11,0.15)',
    obstacleFill: '#D97706',
    obstacleStroke: '#92400E',
    waves: [4, 5, 6],
    enemySpeed: 34,
    enemyFireMs: 1680,
    obstacles: [
      { x: 110, y: 74, w: 34, h: 26 },
      { x: 206, y: 142, w: 48, h: 30 },
      { x: 266, y: 64, w: 28, h: 56 },
    ],
  },
  {
    id: 'salt-flats',
    title: 'Salt Flats',
    subtitle: 'הקרקע לבנה וקשה. כל אויב רואה אותך ממרחק גדול יותר.',
    accent: '#38BDF8',
    skyTop: '#E0F2FE',
    skyBottom: '#F8FAFC',
    terrainA: '#E2E8F0',
    terrainB: '#CBD5E1',
    dust: 'rgba(56,189,248,0.12)',
    obstacleFill: '#94A3B8',
    obstacleStroke: '#475569',
    waves: [5, 6, 7],
    enemySpeed: 39,
    enemyFireMs: 1510,
    obstacles: [
      { x: 84, y: 132, w: 44, h: 30 },
      { x: 160, y: 62, w: 34, h: 54 },
      { x: 254, y: 136, w: 54, h: 28 },
      { x: 270, y: 50, w: 24, h: 28 },
    ],
  },
  {
    id: 'storm-basin',
    title: 'Storm Basin',
    subtitle: 'אבק כבד וטווחי ירי קצרים. זה כבר שלב של תמרון, לא רק של ירי.',
    accent: '#A855F7',
    skyTop: '#DDD6FE',
    skyBottom: '#F5F3FF',
    terrainA: '#C4B5FD',
    terrainB: '#7C3AED',
    dust: 'rgba(168,85,247,0.14)',
    obstacleFill: '#6D28D9',
    obstacleStroke: '#312E81',
    waves: [6, 7, 8],
    enemySpeed: 43,
    enemyFireMs: 1380,
    obstacles: [
      { x: 80, y: 56, w: 28, h: 54 },
      { x: 138, y: 144, w: 52, h: 24 },
      { x: 212, y: 92, w: 38, h: 58 },
      { x: 288, y: 148, w: 26, h: 46 },
    ],
  },
  {
    id: 'furnace-road',
    title: 'Furnace Road',
    subtitle: 'לילה מתכתי, חום קיצוני, ואויבים שנכנסים בגלים קצרים ומהירים.',
    accent: '#F97316',
    skyTop: '#1F2937',
    skyBottom: '#0F172A',
    terrainA: '#7C2D12',
    terrainB: '#EA580C',
    dust: 'rgba(249,115,22,0.12)',
    obstacleFill: '#451A03',
    obstacleStroke: '#FDBA74',
    waves: [7, 8, 9],
    enemySpeed: 48,
    enemyFireMs: 1240,
    obstacles: [
      { x: 90, y: 72, w: 30, h: 30 },
      { x: 152, y: 48, w: 38, h: 64 },
      { x: 146, y: 160, w: 54, h: 26 },
      { x: 240, y: 86, w: 44, h: 48 },
      { x: 288, y: 156, w: 26, h: 36 },
    ],
  },
];

function desertDistance(aX: number, aY: number, bX: number, bY: number) {
  return Math.hypot(bX - aX, bY - aY);
}

function clampTank(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function intersectsObstacle(x: number, y: number, radius: number, obstacles: TankObstacle[]) {
  return obstacles.some((obstacle) => (
    x + radius > obstacle.x
    && x - radius < obstacle.x + obstacle.w
    && y + radius > obstacle.y
    && y - radius < obstacle.y + obstacle.h
  ));
}

function createDesertState(stageIndex: number, score = 0, scrap = 0): DesertGameState {
  return {
    stageIndex,
    waveIndex: 0,
    player: {
      x: 52,
      y: TANK_HEIGHT / 2,
      dir: 'right',
      health: 100,
      fireCooldown: 220,
      invulnerability: 0,
    },
    enemies: [],
    projectiles: [],
    bursts: [],
    score,
    scrap,
    defeats: 0,
    time: 0,
    nextEnemyId: 1,
    nextProjectileId: 1,
    nextBurstId: 1,
  };
}

function directionVector(direction: TankDirection) {
  switch (direction) {
    case 'up':
      return { x: 0, y: -1 };
    case 'down':
      return { x: 0, y: 1 };
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
    default:
      return { x: 1, y: 0 };
  }
}

function angleToDirection(angle: number): TankDirection {
  if (Math.abs(angle) < Math.PI / 4) {
    return 'right';
  }
  if (Math.abs(angle) > (Math.PI * 3) / 4) {
    return 'left';
  }
  return angle > 0 ? 'down' : 'up';
}

function spawnEnemyWave(state: DesertGameState, stage: DesertStageDefinition) {
  const count = stage.waves[state.waveIndex] || stage.waves[stage.waves.length - 1];
  for (let index = 0; index < count; index += 1) {
    const spawnLeft = index % 2 === 0;
    const x = spawnLeft ? 300 + (index % 3) * 16 : 44 + (index % 3) * 18;
    const y = 48 + ((index * 37) % 150);
    state.enemies.push({
      id: state.nextEnemyId,
      x,
      y,
      dir: spawnLeft ? 'left' : 'right',
      health: 3 + Math.floor(state.waveIndex / 2),
      fireCooldown: 520 + Math.random() * 420,
      moveJitter: Math.random() * Math.PI * 2,
    });
    state.nextEnemyId += 1;
  }
}

function pushDesertBurst(state: DesertGameState, x: number, y: number, color: string) {
  state.bursts.push({
    id: state.nextBurstId,
    x,
    y,
    color,
    life: 1,
  });
  state.nextBurstId += 1;
}

function fireProjectile(
  state: DesertGameState,
  x: number,
  y: number,
  angle: number,
  owner: 'player' | 'enemy'
) {
  const speed = owner === 'player' ? 236 : 184;
  state.projectiles.push({
    id: state.nextProjectileId,
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    owner,
    life: 1.2,
  });
  state.nextProjectileId += 1;
}

function drawDesertBackground(context: CanvasRenderingContext2D, stage: DesertStageDefinition, time: number) {
  const gradient = context.createLinearGradient(0, 0, 0, TANK_HEIGHT);
  gradient.addColorStop(0, stage.skyTop);
  gradient.addColorStop(1, stage.skyBottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, TANK_WIDTH, TANK_HEIGHT);

  context.globalAlpha = 0.45;
  for (let i = 0; i < 4; i += 1) {
    context.fillStyle = stage.dust;
    context.beginPath();
    context.ellipse(
      (i * 94 + time * 0.008) % (TANK_WIDTH + 90) - 45,
      40 + i * 22,
      58,
      16,
      0,
      0,
      Math.PI * 2
    );
    context.fill();
  }
  context.globalAlpha = 1;

  context.fillStyle = stage.terrainA;
  context.beginPath();
  context.moveTo(0, TANK_HEIGHT);
  for (let x = 0; x <= TANK_WIDTH; x += 28) {
    context.lineTo(x, 186 + Math.sin(x * 0.022) * 12);
  }
  context.lineTo(TANK_WIDTH, TANK_HEIGHT);
  context.closePath();
  context.fill();

  context.globalAlpha = 0.55;
  context.fillStyle = stage.terrainB;
  context.beginPath();
  context.moveTo(0, TANK_HEIGHT);
  for (let x = 0; x <= TANK_WIDTH; x += 26) {
    context.lineTo(x, 206 + Math.cos(x * 0.024 + time * 0.0011) * 10);
  }
  context.lineTo(TANK_WIDTH, TANK_HEIGHT);
  context.closePath();
  context.fill();
  context.globalAlpha = 1;
}

function drawTank(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  direction: TankDirection,
  bodyColor: string,
  turretColor: string,
  glowColor: string
) {
  const angle = (
    direction === 'up'
      ? -Math.PI / 2
      : direction === 'down'
        ? Math.PI / 2
        : direction === 'left'
          ? Math.PI
          : 0
  );
  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.shadowColor = glowColor;
  context.shadowBlur = 12;
  context.fillStyle = bodyColor;
  context.beginPath();
  context.roundRect(-14, -10, 28, 20, 8);
  context.fill();
  context.shadowBlur = 0;
  context.strokeStyle = 'rgba(15,23,42,0.16)';
  context.lineWidth = 1.5;
  context.stroke();

  context.fillStyle = turretColor;
  context.beginPath();
  context.roundRect(-7, -7, 14, 14, 6);
  context.fill();
  context.fillRect(4, -2, 13, 4);

  context.fillStyle = '#0F172A';
  context.fillRect(-10, -11, 5, 2);
  context.fillRect(5, -11, 5, 2);
  context.fillRect(-10, 9, 5, 2);
  context.fillRect(5, 9, 5, 2);
  context.restore();
}

function drawProjectile(context: CanvasRenderingContext2D, projectile: DesertProjectile) {
  context.save();
  context.fillStyle = projectile.owner === 'player' ? '#FDE68A' : '#FCA5A5';
  context.shadowColor = projectile.owner === 'player' ? '#F59E0B' : '#F43F5E';
  context.shadowBlur = 10;
  context.beginPath();
  context.arc(projectile.x, projectile.y, 3.2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawBurst(context: CanvasRenderingContext2D, burst: DesertBurst) {
  context.save();
  context.globalAlpha = burst.life;
  context.strokeStyle = burst.color;
  context.lineWidth = 3;
  context.beginPath();
  context.arc(burst.x, burst.y, 10 + (1 - burst.life) * 18, 0, Math.PI * 2);
  context.stroke();
  context.restore();
}

export function IronDesertDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const controlsRef = useRef<Record<TankDirection, boolean>>({
    up: false,
    down: false,
    left: false,
    right: false,
  });
  const stateRef = useRef<DesertGameState>(createDesertState(0));
  const [stageIndex, setStageIndex] = useState(0);
  const [waveIndex, setWaveIndex] = useState(0);
  const [health, setHealth] = useState(100);
  const [score, setScore] = useState(0);
  const [scrap, setScrap] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isCampaignComplete, setIsCampaignComplete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [topStatus, setTopStatus] = useState('Iron Desert');

  const stage = useMemo(() => DESERT_STAGES[stageIndex] ?? DESERT_STAGES[0], [stageIndex]);

  const syncHud = useEffectEvent(() => {
    const snapshot = stateRef.current;
    setStageIndex(snapshot.stageIndex);
    setWaveIndex(snapshot.waveIndex);
    setHealth(Math.max(0, Math.round(snapshot.player.health)));
    setScore(snapshot.score);
    setScrap(snapshot.scrap);
  });

  const resetCampaign = useEffectEvent(() => {
    stateRef.current = createDesertState(0);
    spawnEnemyWave(stateRef.current, DESERT_STAGES[0]);
    frameRef.current = null;
    setIsPaused(false);
    setIsGameOver(false);
    setIsCampaignComplete(false);
    setNotice(null);
    setTopStatus('Iron Desert');
    syncHud();
  });

  const advanceStage = useEffectEvent(() => {
    const snapshot = stateRef.current;
    if (snapshot.stageIndex >= DESERT_STAGES.length - 1) {
      setIsCampaignComplete(true);
      setTopStatus('כבשת את כל הזירות');
      setNotice('Iron Desert הושלם עד הסוף.');
      return;
    }

    stateRef.current = createDesertState(snapshot.stageIndex + 1, snapshot.score, snapshot.scrap);
    spawnEnemyWave(stateRef.current, DESERT_STAGES[snapshot.stageIndex + 1]);
    setIsPaused(false);
    setIsGameOver(false);
    setTopStatus('זירה חדשה, שריון חדש');
    setNotice(`נכנסת ל-${DESERT_STAGES[snapshot.stageIndex + 1].title}`);
    syncHud();
  });

  const drawFrame = useEffectEvent(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const snapshot = stateRef.current;
    drawDesertBackground(context, stage, snapshot.time);

    stage.obstacles.forEach((obstacle) => {
      context.fillStyle = stage.obstacleFill;
      context.strokeStyle = stage.obstacleStroke;
      context.lineWidth = 2;
      context.beginPath();
      context.roundRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h, 10);
      context.fill();
      context.stroke();
    });

    drawTank(context, snapshot.player.x, snapshot.player.y, snapshot.player.dir, '#0F766E', '#99F6E4', '#14B8A666');
    snapshot.enemies.forEach((enemy) => drawTank(context, enemy.x, enemy.y, enemy.dir, '#7F1D1D', '#FCA5A5', '#FB718566'));
    snapshot.projectiles.forEach((projectile) => drawProjectile(context, projectile));
    snapshot.bursts.forEach((burst) => drawBurst(context, burst));

    context.fillStyle = 'rgba(15,23,42,0.08)';
    context.fillRect(0, 0, TANK_WIDTH, TANK_HEIGHT);
  });

  const animate = useEffectEvent((timestamp: number) => {
    if (!isOpen) {
      return;
    }
    const lastFrame = frameRef.current ?? timestamp;
    const dt = Math.min(42, timestamp - lastFrame);
    frameRef.current = timestamp;
    const snapshot = stateRef.current;
    const currentStage = DESERT_STAGES[snapshot.stageIndex];
    snapshot.time += dt;

    if (!isPaused && !isGameOver && !isCampaignComplete) {
      const moveX = (controlsRef.current.right ? 1 : 0) - (controlsRef.current.left ? 1 : 0);
      const moveY = (controlsRef.current.down ? 1 : 0) - (controlsRef.current.up ? 1 : 0);
      const vectorLength = Math.hypot(moveX, moveY) || 1;
      const velocity = 94;
      let nextX = snapshot.player.x;
      let nextY = snapshot.player.y;
      if (moveX || moveY) {
        nextX += (moveX / vectorLength) * velocity * dt / 1000;
        nextY += (moveY / vectorLength) * velocity * dt / 1000;
        snapshot.player.dir = angleToDirection(Math.atan2(moveY, moveX));
      }
      nextX = clampTank(nextX, 18, TANK_WIDTH - 18);
      nextY = clampTank(nextY, 18, TANK_HEIGHT - 18);
      if (!intersectsObstacle(nextX, nextY, 14, currentStage.obstacles)) {
        snapshot.player.x = nextX;
        snapshot.player.y = nextY;
      }

      if (snapshot.player.invulnerability > 0) {
        snapshot.player.invulnerability -= dt / 1000;
      }
      snapshot.player.fireCooldown -= dt;

      const nearestEnemy = snapshot.enemies
        .slice()
        .sort((a, b) => desertDistance(snapshot.player.x, snapshot.player.y, a.x, a.y) - desertDistance(snapshot.player.x, snapshot.player.y, b.x, b.y))[0];
      if (nearestEnemy && snapshot.player.fireCooldown <= 0) {
        const angle = Math.atan2(nearestEnemy.y - snapshot.player.y, nearestEnemy.x - snapshot.player.x);
        fireProjectile(snapshot, snapshot.player.x, snapshot.player.y, angle, 'player');
        snapshot.player.fireCooldown = 430;
      }

      snapshot.enemies.forEach((enemy) => {
        enemy.fireCooldown -= dt;
        const angle = Math.atan2(snapshot.player.y - enemy.y, snapshot.player.x - enemy.x);
        enemy.dir = angleToDirection(angle);
        const followDistance = desertDistance(enemy.x, enemy.y, snapshot.player.x, snapshot.player.y);
        if (followDistance > 64) {
          const nextEnemyX = enemy.x + Math.cos(angle + Math.sin(snapshot.time * 0.002 + enemy.moveJitter) * 0.18) * currentStage.enemySpeed * dt / 1000;
          const nextEnemyY = enemy.y + Math.sin(angle + Math.sin(snapshot.time * 0.002 + enemy.moveJitter) * 0.18) * currentStage.enemySpeed * dt / 1000;
          if (
            nextEnemyX > 18 && nextEnemyX < TANK_WIDTH - 18
            && nextEnemyY > 18 && nextEnemyY < TANK_HEIGHT - 18
            && !intersectsObstacle(nextEnemyX, nextEnemyY, 14, currentStage.obstacles)
          ) {
            enemy.x = nextEnemyX;
            enemy.y = nextEnemyY;
          }
        }
        if (enemy.fireCooldown <= 0 && followDistance < 220) {
          fireProjectile(snapshot, enemy.x, enemy.y, angle, 'enemy');
          enemy.fireCooldown = currentStage.enemyFireMs + Math.random() * 260;
        }
      });

      snapshot.projectiles = snapshot.projectiles.filter((projectile) => {
        projectile.x += projectile.vx * dt / 1000;
        projectile.y += projectile.vy * dt / 1000;
        projectile.life -= dt / 1000;
        if (
          projectile.life <= 0
          || projectile.x < -12
          || projectile.x > TANK_WIDTH + 12
          || projectile.y < -12
          || projectile.y > TANK_HEIGHT + 12
          || intersectsObstacle(projectile.x, projectile.y, 4, currentStage.obstacles)
        ) {
          return false;
        }

        if (projectile.owner === 'player') {
          const enemy = snapshot.enemies.find((candidate) => desertDistance(projectile.x, projectile.y, candidate.x, candidate.y) < 16);
          if (enemy) {
            enemy.health -= 1;
            pushDesertBurst(snapshot, projectile.x, projectile.y, '#FDE68A');
            if (enemy.health <= 0) {
              snapshot.score += 110;
              snapshot.scrap += 1;
              snapshot.defeats += 1;
              pushDesertBurst(snapshot, enemy.x, enemy.y, '#FB7185');
            }
            snapshot.enemies = snapshot.enemies.filter((candidate) => candidate.health > 0);
            return false;
          }
        } else if (snapshot.player.invulnerability <= 0 && desertDistance(projectile.x, projectile.y, snapshot.player.x, snapshot.player.y) < 16) {
          snapshot.player.health -= 16;
          snapshot.player.invulnerability = 0.9;
          pushDesertBurst(snapshot, snapshot.player.x, snapshot.player.y, '#38BDF8');
          setNotice('פגיעה ישירה. זוז לפני המטח הבא.');
          return false;
        }

        return true;
      });

      snapshot.bursts = snapshot.bursts
        .map((burst) => ({ ...burst, life: burst.life - dt / 540 }))
        .filter((burst) => burst.life > 0);

      if (snapshot.player.health <= 0) {
        setIsGameOver(true);
        setTopStatus('השריון נפרץ');
        setNotice('הטנק שלך נפל. מאפסים קמפיין ונכנסים שוב.');
      }

      if (snapshot.enemies.length === 0 && !isGameOver) {
        if (snapshot.waveIndex < currentStage.waves.length - 1) {
          snapshot.waveIndex += 1;
          spawnEnemyWave(snapshot, currentStage);
          setNotice(`גל ${snapshot.waveIndex + 1} נפתח.`);
        } else {
          setIsPaused(true);
          setTopStatus('הזירה נוקתה');
          setNotice('הזירה בידיים שלך. המשך לזירה הבאה.');
        }
      }

      syncHud();
    }

    drawFrame();
    animationRef.current = window.requestAnimationFrame(animate);
  });

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    resetCampaign();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        event.preventDefault();
        setIsPaused((current) => !current);
        return;
      }
      if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'w') controlsRef.current.up = true;
      if (event.key === 'ArrowDown' || event.key.toLowerCase() === 's') controlsRef.current.down = true;
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') controlsRef.current.left = true;
      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') controlsRef.current.right = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'w') controlsRef.current.up = false;
      if (event.key === 'ArrowDown' || event.key.toLowerCase() === 's') controlsRef.current.down = false;
      if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') controlsRef.current.left = false;
      if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') controlsRef.current.right = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    animationRef.current = window.requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (animationRef.current) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      frameRef.current = null;
      controlsRef.current = { up: false, down: false, left: false, right: false };
    };
  }, [animate, isOpen, resetCampaign]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setTopStatus(stage.title);
  }, [isOpen, stage.title]);

  if (!isOpen) {
    return null;
  }

  const setControl = (direction: TankDirection, active: boolean) => {
    controlsRef.current[direction] = active;
  };

  return (
    <div className="fixed inset-0 z-[77] flex items-end justify-center bg-slate-950/30 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close Iron Desert"
      />
      <div className="relative z-10 flex max-h-[90dvh] w-full max-w-xl flex-col overflow-y-auto rounded-[2rem] border border-slate-100 bg-white shadow-[0_34px_100px_-38px_rgba(15,23,42,0.45)]">
        <div className="border-b border-slate-100 bg-gradient-to-b from-amber-50/70 via-white to-white px-5 py-4 text-right">
          <div className="flex items-start justify-between gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[1.25rem] bg-gradient-to-br from-amber-100 via-white to-rose-100 text-amber-600 shadow-sm">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Premium Arcade
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-800">Iron Desert</div>
              <div className="mt-1 text-sm leading-6 text-slate-500">{stage.subtitle}</div>
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
              <div className="text-[10px] text-slate-400">זירה</div>
              <div className="mt-1 text-sm font-semibold text-slate-800">{stage.title}</div>
            </div>
            <div className="rounded-[1.1rem] border border-rose-100 bg-rose-50/80 px-3 py-2">
              <div className="text-[10px] text-rose-500">שריון</div>
              <div className="mt-1 text-sm font-semibold text-rose-700">{health}</div>
            </div>
            <div className="rounded-[1.1rem] border border-amber-100 bg-amber-50/80 px-3 py-2">
              <div className="text-[10px] text-amber-500">סקראפ</div>
              <div className="mt-1 text-sm font-semibold text-amber-700">{scrap}</div>
            </div>
            <div className="rounded-[1.1rem] border border-sky-100 bg-sky-50/80 px-3 py-2">
              <div className="text-[10px] text-sky-500">גל</div>
              <div className="mt-1 text-sm font-semibold text-sky-700">{waveIndex + 1} / {stage.waves.length}</div>
            </div>
          </div>

          <div className="overflow-hidden rounded-[1.75rem] border border-slate-100 bg-slate-950 shadow-[0_26px_72px_-36px_rgba(15,23,42,0.56)]">
            <canvas
              ref={canvasRef}
              width={TANK_WIDTH}
              height={TANK_HEIGHT}
              className="block h-auto w-full bg-slate-950"
            />
          </div>

          <div className="rounded-[1.35rem] border border-slate-100 bg-white/90 px-4 py-3 shadow-[0_20px_50px_-40px_rgba(15,23,42,0.32)]">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{topStatus}</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">
                  {notice ?? 'הטנק יורה לבד לאויב הקרוב. אתה מתרכז רק בתמרון, זווית וקצב.'}
                </div>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                ניקוד {score.toLocaleString('en-US')}
              </div>
            </div>
          </div>

          <div dir="ltr" className="mx-auto grid w-[12rem] grid-cols-3 gap-2">
            <div />
            <button
              type="button"
              onPointerDown={() => setControl('up', true)}
              onPointerUp={() => setControl('up', false)}
              onPointerLeave={() => setControl('up', false)}
              onPointerCancel={() => setControl('up', false)}
              className="flex h-11 items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <div />
            <button
              type="button"
              onPointerDown={() => setControl('left', true)}
              onPointerUp={() => setControl('left', false)}
              onPointerLeave={() => setControl('left', false)}
              onPointerCancel={() => setControl('left', false)}
              className="flex h-11 items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
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
              onPointerDown={() => setControl('right', true)}
              onPointerUp={() => setControl('right', false)}
              onPointerLeave={() => setControl('right', false)}
              onPointerCancel={() => setControl('right', false)}
              className="flex h-11 items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            <div />
            <button
              type="button"
              onPointerDown={() => setControl('down', true)}
              onPointerUp={() => setControl('down', false)}
              onPointerLeave={() => setControl('down', false)}
              onPointerCancel={() => setControl('down', false)}
              className="flex h-11 items-center justify-center rounded-[1rem] border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
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
            {isPaused && !isGameOver && !isCampaignComplete && waveIndex >= stage.waves.length - 1 && health > 0 && (
              <button
                type="button"
                onClick={() => advanceStage()}
                className="rounded-full bg-gradient-to-r from-amber-100 via-rose-100 to-sky-100 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:from-amber-200 hover:to-sky-200"
              >
                לזירה הבאה
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
