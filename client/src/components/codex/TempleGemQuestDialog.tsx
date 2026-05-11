import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Command,
  Pause,
  Play,
  RotateCcw,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const TEMPLE_TILE_SIZE = 26;
const TEMPLE_COLS = 13;
const TEMPLE_ROWS = 11;
const TEMPLE_GAME_WIDTH = TEMPLE_COLS * TEMPLE_TILE_SIZE;
const TEMPLE_GAME_HEIGHT = TEMPLE_ROWS * TEMPLE_TILE_SIZE;

type TempleDirection = 'up' | 'down' | 'left' | 'right';
type TempleTile = 'wall' | 'dirt' | 'empty' | 'gem' | 'boulder' | 'key' | 'exit' | 'spike';

interface TempleLevelDefinition {
  id: string;
  title: string;
  subtitle: string;
  map: string[];
}

interface TempleEnemy {
  id: number;
  x: number;
  y: number;
  dir: -1 | 1;
}

interface TempleGameState {
  levelIndex: number;
  playerX: number;
  playerY: number;
  grid: TempleTile[][];
  enemies: TempleEnemy[];
  gemsRemaining: number;
  totalGems: number;
  hasKey: boolean;
  moves: number;
  score: number;
  campaignScore: number;
  deaths: number;
  animTime: number;
}

interface TempleMoveResult {
  moved: boolean;
  outcome: 'idle' | 'blocked' | 'dead' | 'cleared';
  status: string;
  notice?: string;
}

const TEMPLE_LEVELS: TempleLevelDefinition[] = [
  {
    id: 'amber-gate',
    title: 'Amber Gate',
    subtitle: 'אסוף את האבנים, תפוס את המפתח ופתח את שער הענבר.',
    map: [
      '#############',
      '#..*....o..E#',
      '#.###.##.##.#',
      '#P..o..*..k.#',
      '#.##.#.^#.###',
      '#....#...#..#',
      '##o###.#.o#.#',
      '#..*...#....#',
      '#.####.###b.#',
      '#.....*.....#',
      '#############',
    ],
  },
  {
    id: 'jade-vault',
    title: 'Jade Vault',
    subtitle: 'כאן כבר צריך לחשוב על נפילות, דחיפות והדרך חזרה לשער.',
    map: [
      '#############',
      '#P..o....*..#',
      '#.###.##.##.#',
      '#...#..o....#',
      '#.*.#.####..#',
      '#..b#....#..#',
      '#.###.^#.#k.#',
      '#.....o#.*..#',
      '#.####.#.##.#',
      '#....*....E.#',
      '#############',
    ],
  },
  {
    id: 'scarab-lab',
    title: 'Scarab Lab',
    subtitle: 'החיפושית לוחצת אותך. דחוף סלעים חכם, לא מהר.',
    map: [
      '#############',
      '#P...*..o..E#',
      '#.###.##.##.#',
      '#...#..b....#',
      '#.o.#.####..#',
      '#.*...o..#..#',
      '#.###.^#.#k.#',
      '#.....o#.*..#',
      '#.####.#.##.#',
      '#..*.....b..#',
      '#############',
    ],
  },
  {
    id: 'sun-core',
    title: 'Sun Core',
    subtitle: 'הלב של המקדש. כמעט כל צעד כאן משנה את כל הלוח.',
    map: [
      '#############',
      '#P.o..*...E.#',
      '#.###.##.##.#',
      '#..o#..b....#',
      '#.*.#.####..#',
      '#...o...^#..#',
      '#.###.o#.#k.#',
      '#..*..o#..*.#',
      '#.####.#.##.#',
      '#...b...o...#',
      '#############',
    ],
  },
];

function cloneTempleGrid(grid: TempleTile[][]) {
  return grid.map((row) => [...row]);
}

function getTempleTileChar(tile: TempleTile) {
  switch (tile) {
    case 'wall':
      return '#';
    case 'dirt':
      return '.';
    case 'empty':
      return ' ';
    case 'gem':
      return '*';
    case 'boulder':
      return 'o';
    case 'key':
      return 'k';
    case 'exit':
      return 'E';
    case 'spike':
      return '^';
    default:
      return ' ';
  }
}

function createTempleGameState(levelIndex: number, campaignScore = 0, deaths = 0): TempleGameState {
  const level = TEMPLE_LEVELS[levelIndex];
  const grid: TempleTile[][] = [];
  const enemies: TempleEnemy[] = [];
  let playerX = 1;
  let playerY = 1;
  let gemCount = 0;
  let enemyId = 1;

  level.map.forEach((row, y) => {
    const nextRow: TempleTile[] = [];
    row.split('').forEach((char, x) => {
      if (char === 'P') {
        playerX = x;
        playerY = y;
        nextRow.push('empty');
        return;
      }
      if (char === 'b') {
        enemies.push({ id: enemyId++, x, y, dir: x < TEMPLE_COLS / 2 ? 1 : -1 });
        nextRow.push('empty');
        return;
      }

      const tile: TempleTile = (
        char === '#'
          ? 'wall'
          : char === '.'
            ? 'dirt'
            : char === '*'
              ? 'gem'
              : char === 'o'
                ? 'boulder'
                : char === 'k'
                  ? 'key'
                  : char === 'E'
                    ? 'exit'
                    : char === '^'
                      ? 'spike'
                      : 'empty'
      );
      if (tile === 'gem') {
        gemCount += 1;
      }
      nextRow.push(tile);
    });
    grid.push(nextRow);
  });

  return {
    levelIndex,
    playerX,
    playerY,
    grid,
    enemies,
    gemsRemaining: gemCount,
    totalGems: gemCount,
    hasKey: false,
    moves: 0,
    score: 0,
    campaignScore,
    deaths,
    animTime: 0,
  };
}

function isInsideTempleGrid(x: number, y: number) {
  return x >= 0 && x < TEMPLE_COLS && y >= 0 && y < TEMPLE_ROWS;
}

function findTempleEnemyIndex(enemies: TempleEnemy[], x: number, y: number) {
  return enemies.findIndex((enemy) => enemy.x === x && enemy.y === y);
}

function isTemplePlayerAt(state: TempleGameState, x: number, y: number) {
  return state.playerX === x && state.playerY === y;
}

function getTempleTile(state: TempleGameState, x: number, y: number): TempleTile {
  if (!isInsideTempleGrid(x, y)) {
    return 'wall';
  }
  return state.grid[y][x];
}

function setTempleTile(state: TempleGameState, x: number, y: number, tile: TempleTile) {
  if (!isInsideTempleGrid(x, y)) {
    return;
  }
  state.grid[y][x] = tile;
}

function isTempleTileBlocking(tile: TempleTile) {
  return tile === 'wall' || tile === 'boulder' || tile === 'exit';
}

function drawTempleRoundedRect(
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

function resolveTempleFalls(state: TempleGameState) {
  let playerDied = false;

  for (let y = TEMPLE_ROWS - 2; y >= 1; y -= 1) {
    for (let x = 1; x < TEMPLE_COLS - 1; x += 1) {
      const tile = getTempleTile(state, x, y);
      if (tile !== 'boulder' && tile !== 'gem') {
        continue;
      }

      const belowTile = getTempleTile(state, x, y + 1);
      const enemyBelowIndex = findTempleEnemyIndex(state.enemies, x, y + 1);
      const belowHasPlayer = isTemplePlayerAt(state, x, y + 1);

      if (belowTile !== 'empty' && enemyBelowIndex === -1 && !belowHasPlayer) {
        continue;
      }

      setTempleTile(state, x, y, 'empty');
      setTempleTile(state, x, y + 1, tile);
      if (enemyBelowIndex >= 0) {
        state.enemies.splice(enemyBelowIndex, 1);
        state.score += 55;
      }
      if (belowHasPlayer) {
        playerDied = true;
      }
    }
  }

  return playerDied;
}

function moveTempleEnemies(state: TempleGameState) {
  let playerDied = false;

  state.enemies = state.enemies.map((enemy) => {
    let nextDir = enemy.dir;
    const tryMove = (dir: -1 | 1) => {
      const nextX = enemy.x + dir;
      const nextY = enemy.y;
      const tile = getTempleTile(state, nextX, nextY);
      const enemyOccupied = findTempleEnemyIndex(state.enemies, nextX, nextY) >= 0;
      if (enemyOccupied || tile === 'wall' || tile === 'boulder' || tile === 'exit' || tile === 'key' || tile === 'gem') {
        return null;
      }
      return { nextX, nextY };
    };

    let nextPosition = tryMove(enemy.dir);
    if (!nextPosition) {
      nextDir = enemy.dir === 1 ? -1 : 1;
      nextPosition = tryMove(nextDir);
    }

    if (!nextPosition) {
      return { ...enemy, dir: nextDir };
    }

    if (isTemplePlayerAt(state, nextPosition.nextX, nextPosition.nextY)) {
      playerDied = true;
    }

    if (getTempleTile(state, nextPosition.nextX, nextPosition.nextY) === 'dirt') {
      setTempleTile(state, nextPosition.nextX, nextPosition.nextY, 'empty');
    }

    return {
      ...enemy,
      x: nextPosition.nextX,
      y: nextPosition.nextY,
      dir: nextDir,
    };
  });

  return playerDied;
}

function attemptTempleMove(state: TempleGameState, direction: TempleDirection): TempleMoveResult {
  const delta = (
    direction === 'up'
      ? { dx: 0, dy: -1 }
      : direction === 'down'
        ? { dx: 0, dy: 1 }
        : direction === 'left'
          ? { dx: -1, dy: 0 }
          : { dx: 1, dy: 0 }
  );
  const nextX = state.playerX + delta.dx;
  const nextY = state.playerY + delta.dy;
  const targetTile = getTempleTile(state, nextX, nextY);
  const enemyIndex = findTempleEnemyIndex(state.enemies, nextX, nextY);

  if (enemyIndex >= 0 || targetTile === 'spike') {
    return {
      moved: true,
      outcome: 'dead',
      status: 'נתפסת במלכודת',
      notice: 'המקדש ננעל עליך. נסה שוב מאותה נקודה.',
    };
  }

  if (targetTile === 'wall') {
    return {
      moved: false,
      outcome: 'blocked',
      status: 'קיר אבן',
    };
  }

  if (targetTile === 'boulder') {
    if (delta.dy !== 0) {
      return {
        moved: false,
        outcome: 'blocked',
        status: 'צריך לדחוף מהצד',
      };
    }
    const beyondX = nextX + delta.dx;
    const beyondTile = getTempleTile(state, beyondX, nextY);
    if (beyondTile !== 'empty' || findTempleEnemyIndex(state.enemies, beyondX, nextY) >= 0) {
      return {
        moved: false,
        outcome: 'blocked',
        status: 'הסלע תקוע',
      };
    }
    setTempleTile(state, beyondX, nextY, 'boulder');
    setTempleTile(state, nextX, nextY, 'empty');
  }

  if (targetTile === 'exit') {
    if (!state.hasKey) {
      return {
        moved: false,
        outcome: 'blocked',
        status: 'צריך מפתח',
        notice: 'הדלת עוד נעולה. חפש את המפתח.',
      };
    }
    if (state.gemsRemaining > 0) {
      return {
        moved: false,
        outcome: 'blocked',
        status: 'חסרים יהלומים',
        notice: `נשארו עוד ${state.gemsRemaining} יהלומים לפני היציאה.`,
      };
    }

    state.playerX = nextX;
    state.playerY = nextY;
    state.moves += 1;
    state.score += Math.max(80, 220 - state.moves * 4);
    return {
      moved: true,
      outcome: 'cleared',
      status: 'השער נפתח',
      notice: 'מעולה. היציאה פתוחה והשלב הושלם.',
    };
  }

  state.playerX = nextX;
  state.playerY = nextY;
  state.moves += 1;

  if (targetTile === 'dirt') {
    setTempleTile(state, nextX, nextY, 'empty');
  } else if (targetTile === 'gem') {
    setTempleTile(state, nextX, nextY, 'empty');
    state.gemsRemaining = Math.max(0, state.gemsRemaining - 1);
    state.score += 45;
  } else if (targetTile === 'key') {
    setTempleTile(state, nextX, nextY, 'empty');
    state.hasKey = true;
    state.score += 70;
  }

  const fellOnPlayer = resolveTempleFalls(state);
  const enemyHitPlayer = moveTempleEnemies(state);
  if (fellOnPlayer || enemyHitPlayer) {
    return {
      moved: true,
      outcome: 'dead',
      status: 'המערה קרסה',
      notice: 'הסלעים והחיפושיות לא סלחו. נסה שוב באותו שלב.',
    };
  }

  if (state.gemsRemaining === 0 && state.hasKey) {
    return {
      moved: true,
      outcome: 'idle',
      status: 'הדלת מוכנה',
      notice: 'כל היהלומים בידך. עכשיו אפשר לצאת.',
    };
  }

  if (targetTile === 'gem') {
    return {
      moved: true,
      outcome: 'idle',
      status: 'יהלום נאסף',
    };
  }

  if (targetTile === 'key') {
    return {
      moved: true,
      outcome: 'idle',
      status: 'המפתח בידך',
      notice: state.gemsRemaining > 0 ? 'עכשיו צריך להשלים את כל היהלומים.' : 'עכשיו הדלת יכולה להיפתח.',
    };
  }

  return {
    moved: true,
    outcome: 'idle',
    status: 'ממשיך במקדש',
  };
}

function drawTempleGame(context: CanvasRenderingContext2D, state: TempleGameState) {
  context.clearRect(0, 0, TEMPLE_GAME_WIDTH, TEMPLE_GAME_HEIGHT);

  const sky = context.createLinearGradient(0, 0, 0, TEMPLE_GAME_HEIGHT);
  sky.addColorStop(0, '#FFF9ED');
  sky.addColorStop(0.48, '#FDE68A');
  sky.addColorStop(1, '#D9F99D');
  context.fillStyle = sky;
  context.fillRect(0, 0, TEMPLE_GAME_WIDTH, TEMPLE_GAME_HEIGHT);

  const aura = context.createRadialGradient(
    TEMPLE_GAME_WIDTH * 0.68,
    TEMPLE_GAME_HEIGHT * 0.18,
    24,
    TEMPLE_GAME_WIDTH * 0.68,
    TEMPLE_GAME_HEIGHT * 0.18,
    150
  );
  aura.addColorStop(0, 'rgba(255,255,255,0.95)');
  aura.addColorStop(0.24, 'rgba(250,204,21,0.34)');
  aura.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = aura;
  context.fillRect(0, 0, TEMPLE_GAME_WIDTH, TEMPLE_GAME_HEIGHT);

  const pulse = (Math.sin(state.animTime * 2.8) + 1) / 2;

  for (let y = 0; y < TEMPLE_ROWS; y += 1) {
    for (let x = 0; x < TEMPLE_COLS; x += 1) {
      const tile = state.grid[y][x];
      const drawX = x * TEMPLE_TILE_SIZE;
      const drawY = y * TEMPLE_TILE_SIZE;

      context.fillStyle = y % 2 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.02)';
      context.fillRect(drawX, drawY, TEMPLE_TILE_SIZE, TEMPLE_TILE_SIZE);

      if (tile === 'empty') {
        continue;
      }

      if (tile === 'wall') {
        const wallGradient = context.createLinearGradient(drawX, drawY, drawX, drawY + TEMPLE_TILE_SIZE);
        wallGradient.addColorStop(0, '#8B6B4D');
        wallGradient.addColorStop(0.55, '#7C5A3E');
        wallGradient.addColorStop(1, '#5B4332');
        drawTempleRoundedRect(context, drawX + 1.5, drawY + 1.5, TEMPLE_TILE_SIZE - 3, TEMPLE_TILE_SIZE - 3, 6);
        context.fillStyle = wallGradient;
        context.fill();
        context.fillStyle = 'rgba(255,255,255,0.12)';
        context.fillRect(drawX + 4, drawY + 4, TEMPLE_TILE_SIZE - 8, 3);
        context.strokeStyle = 'rgba(15,23,42,0.08)';
        context.strokeRect(drawX + 5, drawY + 7, TEMPLE_TILE_SIZE - 10, TEMPLE_TILE_SIZE - 12);
        continue;
      }

      if (tile === 'dirt') {
        const dirtGradient = context.createLinearGradient(drawX, drawY, drawX, drawY + TEMPLE_TILE_SIZE);
        dirtGradient.addColorStop(0, '#E9C087');
        dirtGradient.addColorStop(1, '#D4A373');
        drawTempleRoundedRect(context, drawX + 3, drawY + 3, TEMPLE_TILE_SIZE - 6, TEMPLE_TILE_SIZE - 6, 6);
        context.fillStyle = dirtGradient;
        context.fill();
        context.fillStyle = 'rgba(124,69,33,0.16)';
        context.beginPath();
        context.arc(drawX + 8, drawY + 9, 1.3, 0, Math.PI * 2);
        context.arc(drawX + 17, drawY + 13, 1.2, 0, Math.PI * 2);
        context.arc(drawX + 10, drawY + 18, 1.6, 0, Math.PI * 2);
        context.fill();
        continue;
      }

      if (tile === 'boulder') {
        const boulderGradient = context.createRadialGradient(
          drawX + TEMPLE_TILE_SIZE * 0.42,
          drawY + TEMPLE_TILE_SIZE * 0.38,
          3,
          drawX + TEMPLE_TILE_SIZE * 0.5,
          drawY + TEMPLE_TILE_SIZE * 0.5,
          TEMPLE_TILE_SIZE * 0.48
        );
        boulderGradient.addColorStop(0, '#F8FAFC');
        boulderGradient.addColorStop(0.32, '#CBD5E1');
        boulderGradient.addColorStop(1, '#64748B');
        context.fillStyle = boulderGradient;
        context.beginPath();
        context.arc(drawX + TEMPLE_TILE_SIZE / 2, drawY + TEMPLE_TILE_SIZE / 2, TEMPLE_TILE_SIZE * 0.36, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = 'rgba(15,23,42,0.12)';
        context.beginPath();
        context.arc(drawX + 9, drawY + 9, 2, 0, Math.PI * 2);
        context.arc(drawX + 17, drawY + 16, 1.6, 0, Math.PI * 2);
        context.fill();
        continue;
      }

      if (tile === 'gem') {
        const gemGradient = context.createLinearGradient(drawX, drawY + 4, drawX, drawY + TEMPLE_TILE_SIZE - 4);
        gemGradient.addColorStop(0, '#ECFEFF');
        gemGradient.addColorStop(0.4, '#60A5FA');
        gemGradient.addColorStop(1, '#2563EB');
        context.save();
        context.translate(drawX + TEMPLE_TILE_SIZE / 2, drawY + TEMPLE_TILE_SIZE / 2);
        context.scale(1 + pulse * 0.04, 1 + pulse * 0.04);
        context.beginPath();
        context.moveTo(0, -8);
        context.lineTo(8, 0);
        context.lineTo(0, 9);
        context.lineTo(-8, 0);
        context.closePath();
        context.fillStyle = gemGradient;
        context.fill();
        context.fillStyle = 'rgba(255,255,255,0.75)';
        context.fillRect(-1, -5, 2, 9);
        context.restore();
        continue;
      }

      if (tile === 'key') {
        context.save();
        context.translate(drawX + TEMPLE_TILE_SIZE / 2, drawY + TEMPLE_TILE_SIZE / 2);
        context.strokeStyle = '#F59E0B';
        context.lineWidth = 3;
        context.beginPath();
        context.arc(-3, -1, 5, 0, Math.PI * 2);
        context.moveTo(2, -1);
        context.lineTo(10, -1);
        context.moveTo(8, -1);
        context.lineTo(8, 4);
        context.moveTo(5, -1);
        context.lineTo(5, 2);
        context.stroke();
        context.restore();
        continue;
      }

      if (tile === 'exit') {
        const unlocked = state.gemsRemaining === 0 && state.hasKey;
        const exitGradient = context.createLinearGradient(drawX, drawY, drawX, drawY + TEMPLE_TILE_SIZE);
        exitGradient.addColorStop(0, unlocked ? '#DCFCE7' : '#FED7AA');
        exitGradient.addColorStop(1, unlocked ? '#16A34A' : '#EA580C');
        drawTempleRoundedRect(context, drawX + 3, drawY + 3, TEMPLE_TILE_SIZE - 6, TEMPLE_TILE_SIZE - 6, 8);
        context.fillStyle = exitGradient;
        context.fill();
        context.fillStyle = 'rgba(15,23,42,0.16)';
        drawTempleRoundedRect(context, drawX + 8, drawY + 7, TEMPLE_TILE_SIZE - 16, TEMPLE_TILE_SIZE - 10, 8);
        context.fill();
        if (unlocked) {
          context.strokeStyle = `rgba(255,255,255,${0.4 + pulse * 0.3})`;
          context.lineWidth = 2;
          context.strokeRect(drawX + 4, drawY + 4, TEMPLE_TILE_SIZE - 8, TEMPLE_TILE_SIZE - 8);
        }
        continue;
      }

      if (tile === 'spike') {
        context.fillStyle = '#E11D48';
        context.beginPath();
        context.moveTo(drawX + 4, drawY + TEMPLE_TILE_SIZE - 5);
        context.lineTo(drawX + 9, drawY + 6);
        context.lineTo(drawX + 13, drawY + TEMPLE_TILE_SIZE - 5);
        context.lineTo(drawX + 18, drawY + 6);
        context.lineTo(drawX + 22, drawY + TEMPLE_TILE_SIZE - 5);
        context.closePath();
        context.fill();
      }
    }
  }

  state.enemies.forEach((enemy) => {
    const drawX = enemy.x * TEMPLE_TILE_SIZE;
    const drawY = enemy.y * TEMPLE_TILE_SIZE;
    context.save();
    context.translate(drawX + TEMPLE_TILE_SIZE / 2, drawY + TEMPLE_TILE_SIZE / 2);
    context.fillStyle = '#0F172A';
    context.beginPath();
    context.ellipse(0, 1, 8, 6.5, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#7C3AED';
    context.beginPath();
    context.ellipse(0, -1, 6, 4.5, 0, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = 'rgba(255,255,255,0.6)';
    context.lineWidth = 1.6;
    context.beginPath();
    context.moveTo(-5, 6);
    context.lineTo(-8, 10);
    context.moveTo(5, 6);
    context.lineTo(8, 10);
    context.moveTo(-5, 0);
    context.lineTo(-9, -2);
    context.moveTo(5, 0);
    context.lineTo(9, -2);
    context.stroke();
    context.restore();
  });

  context.save();
  context.translate(state.playerX * TEMPLE_TILE_SIZE + TEMPLE_TILE_SIZE / 2, state.playerY * TEMPLE_TILE_SIZE + TEMPLE_TILE_SIZE / 2);
  context.fillStyle = 'rgba(15,23,42,0.15)';
  context.beginPath();
  context.ellipse(0, 9, 8.5, 4, 0, 0, Math.PI * 2);
  context.fill();

  const explorerGradient = context.createLinearGradient(0, -11, 0, 11);
  explorerGradient.addColorStop(0, '#FEF3C7');
  explorerGradient.addColorStop(0.35, '#FB7185');
  explorerGradient.addColorStop(1, '#2563EB');
  drawTempleRoundedRect(context, -9, -10, 18, 20, 7);
  context.fillStyle = explorerGradient;
  context.fill();
  context.fillStyle = '#FFF7ED';
  context.beginPath();
  context.arc(0, -4, 5.5, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#0F172A';
  context.beginPath();
  context.arc(-2, -5, 0.9, 0, Math.PI * 2);
  context.arc(2, -5, 0.9, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = '#B45309';
  context.fillRect(-6, -11, 12, 2.6);
  context.fillRect(-2.5, -15, 5, 4);
  context.restore();
}

export function TempleGemQuestDialog({
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
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const stateRef = useRef<TempleGameState>(createTempleGameState(0));
  const [levelIndex, setLevelIndex] = useState(0);
  const [moves, setMoves] = useState(0);
  const [gemsRemaining, setGemsRemaining] = useState(stateRef.current.gemsRemaining);
  const [totalGems, setTotalGems] = useState(stateRef.current.totalGems);
  const [hasKey, setHasKey] = useState(false);
  const [score, setScore] = useState(0);
  const [deaths, setDeaths] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [topStatus, setTopStatus] = useState('Temple Gem Quest');
  const [isPaused, setIsPaused] = useState(false);
  const [isStageCleared, setIsStageCleared] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isCampaignComplete, setIsCampaignComplete] = useState(false);

  const currentLevel = useMemo(() => TEMPLE_LEVELS[levelIndex], [levelIndex]);

  const syncHud = useEffectEvent(() => {
    const snapshot = stateRef.current;
    setLevelIndex(snapshot.levelIndex);
    setMoves(snapshot.moves);
    setGemsRemaining(snapshot.gemsRemaining);
    setTotalGems(snapshot.totalGems);
    setHasKey(snapshot.hasKey);
    setScore(snapshot.campaignScore + snapshot.score);
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
      }, 2400);
    }
  });

  const loadLevel = useEffectEvent((nextLevelIndex: number, campaignScore = 0, nextDeaths = 0) => {
    stateRef.current = createTempleGameState(nextLevelIndex, campaignScore, nextDeaths);
    setIsPaused(false);
    setIsStageCleared(false);
    setIsGameOver(false);
    setIsCampaignComplete(false);
    setTopStatus(sessionActiveCount > 0 ? 'הסשן רץ ברקע' : TEMPLE_LEVELS[nextLevelIndex].title);
    showNotice(TEMPLE_LEVELS[nextLevelIndex].subtitle);
    syncHud();
  });

  const resetCurrentLevel = useEffectEvent(() => {
    const snapshot = stateRef.current;
    loadLevel(snapshot.levelIndex, snapshot.campaignScore, snapshot.deaths);
  });

  const restartCampaign = useEffectEvent(() => {
    loadLevel(0, 0, 0);
  });

  const advanceLevel = useEffectEvent(() => {
    const snapshot = stateRef.current;
    const bonus = Math.max(60, 220 - snapshot.moves * 4);
    const carriedScore = snapshot.campaignScore + snapshot.score + bonus;
    if (snapshot.levelIndex >= TEMPLE_LEVELS.length - 1) {
      setIsStageCleared(false);
      setIsCampaignComplete(true);
      setTopStatus('האוצר בידך');
      showNotice('סגרת את כל קמפיין המקדשים. אפשר להתחיל שוב או לחזור לצ׳אט.');
      stateRef.current = {
        ...snapshot,
        campaignScore: carriedScore,
        score: 0,
      };
      syncHud();
      return;
    }

    loadLevel(snapshot.levelIndex + 1, carriedScore, snapshot.deaths);
  });

  const handleMove = useEffectEvent((direction: TempleDirection) => {
    if (isPaused || isStageCleared || isGameOver || isCampaignComplete) {
      return;
    }

    const result = attemptTempleMove(stateRef.current, direction);
    if (result.notice) {
      showNotice(result.notice);
    }

    if (result.outcome === 'dead') {
      stateRef.current = {
        ...stateRef.current,
        deaths: stateRef.current.deaths + 1,
      };
      setIsGameOver(true);
      setTopStatus(result.status);
      syncHud();
      return;
    }

    if (result.outcome === 'cleared') {
      setIsStageCleared(true);
      setTopStatus(result.status);
      syncHud();
      return;
    }

    if (result.moved || result.outcome === 'blocked') {
      setTopStatus(result.status);
      syncHud();
    }
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    loadLevel(0, 0, 0);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'w' || event.key === 'W') {
        event.preventDefault();
        handleMove('up');
      } else if (event.key === 'ArrowDown' || event.key === 's' || event.key === 'S') {
        event.preventDefault();
        handleMove('down');
      } else if (event.key === 'ArrowLeft' || event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        handleMove('left');
      } else if (event.key === 'ArrowRight' || event.key === 'd' || event.key === 'D') {
        event.preventDefault();
        handleMove('right');
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
    if (!isPaused && !isGameOver && !isStageCleared && !isCampaignComplete) {
      setTopStatus(TEMPLE_LEVELS[stateRef.current.levelIndex].title);
    }
  }, [isCampaignComplete, isGameOver, isOpen, isPaused, isStageCleared, sessionActiveCount]);

  useEffect(() => {
    if (!isOpen || sessionCompletionSignal === 0) {
      return;
    }
    showNotice('הסשן הושלם ברקע. אפשר לחזור לצ׳אט או להמשיך לצלול במקדש.');
    setTopStatus('הסשן הושלם');
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
      stateRef.current.animTime = frameTime / 1000;
      drawTempleGame(context, stateRef.current);
      animationRef.current = window.requestAnimationFrame(render);
    };

    animationRef.current = window.requestAnimationFrame(render);
    return () => {
      if (animationRef.current) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[77] flex items-end justify-center bg-slate-950/30 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close temple gem quest"
      />
      <div className="relative z-10 flex w-full max-w-sm flex-col overflow-hidden rounded-[2rem] border border-amber-100 bg-white text-slate-800 shadow-[0_30px_100px_-40px_rgba(251,191,36,0.35)]">
        <div className="border-b border-amber-100 bg-gradient-to-b from-amber-50 via-emerald-50 to-white px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-amber-600 shadow-sm"
              title={topStatus}
            >
              <Command className="h-5 w-5" />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsPaused((current) => !current)}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-amber-50"
              >
                {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => resetCurrentLevel()}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-amber-50"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-white p-2 text-slate-700 transition hover:bg-amber-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-3 text-right">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
              Temple Gem Quest
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <div className="text-lg font-semibold text-slate-800">{currentLevel.title}</div>
              <span className="rounded-full bg-white/90 px-2.5 py-1 text-[10px] font-semibold text-amber-700 shadow-sm">
                שלב {levelIndex + 1}/{TEMPLE_LEVELS.length}
              </span>
            </div>
            <div className="mt-1 text-xs leading-5 text-slate-500">{currentLevel.subtitle}</div>
          </div>

          <div className="mt-4 grid grid-cols-5 gap-2 text-xs">
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Score</div>
              <div className="mt-1 text-base font-semibold">{score}</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Gems</div>
              <div className="mt-1 text-base font-semibold">
                {totalGems - gemsRemaining}/{totalGems}
              </div>
            </div>
            <div className={cn('rounded-2xl bg-white px-3 py-2', hasKey && 'bg-emerald-50 text-emerald-700')}>
              <div className={cn('text-slate-400', hasKey && 'text-emerald-500')}>Key</div>
              <div className="mt-1 text-base font-semibold">{hasKey ? 'כן' : 'לא'}</div>
            </div>
            <div className="rounded-2xl bg-white px-3 py-2">
              <div className="text-slate-400">Moves</div>
              <div className="mt-1 text-base font-semibold">{moves}</div>
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
            width={TEMPLE_GAME_WIDTH}
            height={TEMPLE_GAME_HEIGHT}
            onPointerDown={(event: PointerEvent<HTMLCanvasElement>) => {
              swipeStartRef.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerUp={(event: PointerEvent<HTMLCanvasElement>) => {
              if (!swipeStartRef.current) {
                return;
              }
              const dx = event.clientX - swipeStartRef.current.x;
              const dy = event.clientY - swipeStartRef.current.y;
              swipeStartRef.current = null;
              if (Math.abs(dx) < 18 && Math.abs(dy) < 18) {
                return;
              }
              if (Math.abs(dx) > Math.abs(dy)) {
                handleMove(dx > 0 ? 'right' : 'left');
              } else {
                handleMove(dy > 0 ? 'down' : 'up');
              }
            }}
            className="aspect-[338/286] h-auto max-h-[46dvh] w-full touch-none rounded-[1.5rem] border border-white/20 bg-slate-900"
          />

          {notice && (
            <div className="pointer-events-none absolute left-8 right-8 top-8 rounded-full bg-amber-400/95 px-4 py-2 text-center text-sm font-semibold text-slate-950 shadow-lg">
              {notice}
            </div>
          )}

          {(isGameOver || isStageCleared || isCampaignComplete) && (
            <div className="absolute inset-8 flex items-center justify-center rounded-[1.5rem] bg-slate-950/60 backdrop-blur-sm">
              <div className="w-full max-w-[16rem] text-center text-white">
                <div className="text-xl font-bold">
                  {isCampaignComplete
                    ? 'האוצר הושלם'
                    : isStageCleared
                      ? 'השער נפתח'
                      : 'השלב נסגר עליך'}
                </div>
                <div className="mt-2 text-sm leading-6 text-slate-200">
                  {isCampaignComplete
                    ? 'סגרת את כל קמפיין המקדש. אפשר להתחיל מהתחלה ולרדוף אחרי ציון נקי יותר.'
                    : isStageCleared
                      ? 'השלב מאחוריך. לחץ כדי להיכנס עמוק יותר למקדש.'
                      : 'אפשר להפעיל מחדש את אותו שלב או להתחיל מחדש את כל הקמפיין.'}
                </div>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {isStageCleared && !isCampaignComplete && (
                    <button
                      type="button"
                      onClick={() => advanceLevel()}
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
                    onClick={() => resetCurrentLevel()}
                    className="rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/15"
                  >
                    נסה שוב
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-3 border-t border-amber-100 bg-gradient-to-b from-white to-amber-50/40 px-4 pb-4 pt-3">
          <div dir="ltr" className="mx-auto grid w-full max-w-[12rem] grid-cols-3 gap-2">
            <div />
            <button
              type="button"
              onClick={() => handleMove('up')}
              className="flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-amber-50"
            >
              <ChevronUp className="h-5 w-5" />
            </button>
            <div />
            <button
              type="button"
              onClick={() => handleMove('left')}
              className="flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-amber-50"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => handleMove('down')}
              className="flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-amber-50"
            >
              <ChevronDown className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={() => handleMove('right')}
              className="flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:bg-amber-50"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
            <span dir="rtl">{topStatus}</span>
            <span className="shrink-0">{gemsRemaining === 0 && hasKey ? 'היציאה פתוחה' : 'אסוף הכל ואז צא'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
