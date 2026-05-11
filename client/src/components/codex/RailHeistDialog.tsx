import { useEffect, useEffectEvent, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  Pause,
  Play,
  RotateCcw,
  TrainFront,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const RAIL_WIDTH = 360;
const RAIL_HEIGHT = 248;

type RailTrainKind = 'loot' | 'rescue';
type RailTheme = 'aurora' | 'canyon' | 'harbor' | 'obsidian';

interface RailNodeBase {
  id: string;
  x: number;
  y: number;
  label: string;
}

interface RailSpawnNode extends RailNodeBase {
  type: 'spawn';
  kind: RailTrainKind;
  next: [string];
}

interface RailJunctionNode extends RailNodeBase {
  type: 'junction';
  next: [string, string];
  branchLabels: [string, string];
}

interface RailGoalNode extends RailNodeBase {
  type: 'goal-loot' | 'goal-rescue';
}

type RailNode = RailSpawnNode | RailJunctionNode | RailGoalNode;

interface RailSpawnPlan {
  spawnId: string;
  kind: RailTrainKind;
}

interface RailStageDefinition {
  id: string;
  title: string;
  subtitle: string;
  theme: RailTheme;
  targetDeliveries: number;
  maxIntegrity: number;
  spawnIntervalMs: number;
  baseSpeed: number;
  skyTop: string;
  skyBottom: string;
  glowA: string;
  glowB: string;
  trackBase: string;
  rail: string;
  sleeper: string;
  terrainA: string;
  terrainB: string;
  nodes: RailNode[];
  spawnPattern: RailSpawnPlan[];
}

interface RailTrain {
  id: number;
  kind: RailTrainKind;
  fromId: string;
  toId: string;
  progress: number;
  speed: number;
}

interface RailBurst {
  id: number;
  x: number;
  y: number;
  life: number;
  color: string;
}

interface RailGameState {
  stageIndex: number;
  switches: Record<string, 0 | 1>;
  trains: RailTrain[];
  spawnCursor: number;
  spawnCooldown: number;
  stageDelivered: number;
  campaignDelivered: number;
  score: number;
  integrity: number;
  combo: number;
  time: number;
  bursts: RailBurst[];
  nextTrainId: number;
  nextBurstId: number;
}

const LOOT_COLOR = '#F59E0B';
const RESCUE_COLOR = '#22D3EE';

const RAIL_STAGES: RailStageDefinition[] = [
  {
    id: 'aurora-switchyard',
    title: 'Aurora Switchyard',
    subtitle: 'מסילות קרח וזוהר צפוני. שלח את רכבות השלל למנהרה ואת רכבות החילוץ לנמל.',
    theme: 'aurora',
    targetDeliveries: 10,
    maxIntegrity: 3,
    spawnIntervalMs: 2950,
    baseSpeed: 92,
    skyTop: '#DDF4FF',
    skyBottom: '#F8FAFC',
    glowA: 'rgba(34,211,238,0.26)',
    glowB: 'rgba(129,140,248,0.22)',
    trackBase: '#CBD5E1',
    rail: '#F8FAFC',
    sleeper: '#94A3B8',
    terrainA: '#D9F99D',
    terrainB: '#BAE6FD',
    nodes: [
      { id: 'lootSpawn', type: 'spawn', kind: 'loot', label: 'שלל', x: 24, y: 68, next: ['hub'] },
      { id: 'rescueSpawn', type: 'spawn', kind: 'rescue', label: 'חילוץ', x: 24, y: 182, next: ['hub'] },
      { id: 'hub', type: 'junction', label: 'H1', x: 118, y: 126, next: ['north', 'south'], branchLabels: ['מנהרה', 'נמל'] },
      { id: 'north', type: 'goal-loot', label: 'מנהרת שלל', x: 330, y: 70 },
      { id: 'south', type: 'goal-rescue', label: 'נמל חילוץ', x: 330, y: 184 },
    ],
    spawnPattern: [
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
      { spawnId: 'lootSpawn', kind: 'loot' },
    ],
  },
  {
    id: 'canyon-split',
    title: 'Canyon Split',
    subtitle: 'הקניון שולח הכל דרך גשרי רוח. שני סוויצ׳ים, אפס טעויות.',
    theme: 'canyon',
    targetDeliveries: 12,
    maxIntegrity: 3,
    spawnIntervalMs: 2550,
    baseSpeed: 102,
    skyTop: '#FFE7C2',
    skyBottom: '#FFF7ED',
    glowA: 'rgba(251,146,60,0.24)',
    glowB: 'rgba(245,158,11,0.22)',
    trackBase: '#FED7AA',
    rail: '#FFF7ED',
    sleeper: '#C2410C',
    terrainA: '#FDBA74',
    terrainB: '#EA580C',
    nodes: [
      { id: 'lootSpawn', type: 'spawn', kind: 'loot', label: 'שלל', x: 24, y: 56, next: ['west'] },
      { id: 'rescueSpawn', type: 'spawn', kind: 'rescue', label: 'חילוץ', x: 24, y: 194, next: ['west'] },
      { id: 'west', type: 'junction', label: 'W', x: 104, y: 126, next: ['midTop', 'midBottom'], branchLabels: ['גשר שמיים', 'קניון תחתון'] },
      { id: 'midTop', type: 'junction', label: 'T', x: 214, y: 78, next: ['lootGoal', 'rescueGoal'], branchLabels: ['מנהרה', 'נמל'] },
      { id: 'midBottom', type: 'junction', label: 'B', x: 214, y: 176, next: ['lootGoal', 'rescueGoal'], branchLabels: ['מנהרה', 'נמל'] },
      { id: 'lootGoal', type: 'goal-loot', label: 'מנהרת שלל', x: 330, y: 62 },
      { id: 'rescueGoal', type: 'goal-rescue', label: 'נמל חילוץ', x: 330, y: 190 },
    ],
    spawnPattern: [
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
    ],
  },
  {
    id: 'neon-harbor',
    title: 'Neon Harbor',
    subtitle: 'מסילות על רציפים רטובים. רכבות נחתכות דרך צומת כפול בלב הנמל.',
    theme: 'harbor',
    targetDeliveries: 14,
    maxIntegrity: 3,
    spawnIntervalMs: 2280,
    baseSpeed: 112,
    skyTop: '#DBEAFE',
    skyBottom: '#F5F3FF',
    glowA: 'rgba(59,130,246,0.24)',
    glowB: 'rgba(236,72,153,0.22)',
    trackBase: '#C7D2FE',
    rail: '#F8FAFC',
    sleeper: '#6366F1',
    terrainA: '#93C5FD',
    terrainB: '#A78BFA',
    nodes: [
      { id: 'lootSpawn', type: 'spawn', kind: 'loot', label: 'שלל', x: 26, y: 52, next: ['northWest'] },
      { id: 'rescueSpawn', type: 'spawn', kind: 'rescue', label: 'חילוץ', x: 26, y: 196, next: ['southWest'] },
      { id: 'northWest', type: 'junction', label: 'N', x: 96, y: 74, next: ['crossTop', 'crossBottom'], branchLabels: ['קו עליון', 'קו צולב'] },
      { id: 'southWest', type: 'junction', label: 'S', x: 96, y: 174, next: ['crossTop', 'crossBottom'], branchLabels: ['קו עליון', 'קו צולב'] },
      { id: 'crossTop', type: 'junction', label: 'C1', x: 200, y: 62, next: ['lootGoal', 'rescueGoal'], branchLabels: ['מנהרה', 'נמל'] },
      { id: 'crossBottom', type: 'junction', label: 'C2', x: 200, y: 186, next: ['lootGoal', 'rescueGoal'], branchLabels: ['מנהרה', 'נמל'] },
      { id: 'lootGoal', type: 'goal-loot', label: 'מנהרת שלל', x: 330, y: 70 },
      { id: 'rescueGoal', type: 'goal-rescue', label: 'נמל חילוץ', x: 330, y: 178 },
    ],
    spawnPattern: [
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
    ],
  },
  {
    id: 'obsidian-finale',
    title: 'Obsidian Finale',
    subtitle: 'המסילות האחרונות תלויות מעל זכוכית וולקנית. שלושה סוויצ׳ים, מהירות קצה.',
    theme: 'obsidian',
    targetDeliveries: 16,
    maxIntegrity: 3,
    spawnIntervalMs: 2020,
    baseSpeed: 124,
    skyTop: '#1E1B4B',
    skyBottom: '#111827',
    glowA: 'rgba(249,115,22,0.24)',
    glowB: 'rgba(244,63,94,0.22)',
    trackBase: '#312E81',
    rail: '#F8FAFC',
    sleeper: '#F97316',
    terrainA: '#7C2D12',
    terrainB: '#581C87',
    nodes: [
      { id: 'lootSpawn', type: 'spawn', kind: 'loot', label: 'שלל', x: 26, y: 50, next: ['west'] },
      { id: 'rescueSpawn', type: 'spawn', kind: 'rescue', label: 'חילוץ', x: 26, y: 198, next: ['west'] },
      { id: 'west', type: 'junction', label: 'W', x: 90, y: 126, next: ['upper', 'lower'], branchLabels: ['פסגה', 'תעלה'] },
      { id: 'upper', type: 'junction', label: 'U', x: 180, y: 56, next: ['mid', 'rescueGoal'], branchLabels: ['מרכז', 'נמל'] },
      { id: 'lower', type: 'junction', label: 'L', x: 180, y: 196, next: ['lootGoal', 'mid'], branchLabels: ['מנהרה', 'מרכז'] },
      { id: 'mid', type: 'junction', label: 'M', x: 260, y: 126, next: ['lootGoal', 'rescueGoal'], branchLabels: ['מנהרה', 'נמל'] },
      { id: 'lootGoal', type: 'goal-loot', label: 'מנהרת שלל', x: 330, y: 58 },
      { id: 'rescueGoal', type: 'goal-rescue', label: 'נמל חילוץ', x: 330, y: 194 },
    ],
    spawnPattern: [
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
      { spawnId: 'lootSpawn', kind: 'loot' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
      { spawnId: 'rescueSpawn', kind: 'rescue' },
      { spawnId: 'lootSpawn', kind: 'loot' },
    ],
  },
];

function getNodeMap(stage: RailStageDefinition) {
  return Object.fromEntries(stage.nodes.map((node) => [node.id, node])) as Record<string, RailNode>;
}

function createRailState(stageIndex: number, score = 0, campaignDelivered = 0): RailGameState {
  const stage = RAIL_STAGES[stageIndex];
  const switches = Object.fromEntries(
    stage.nodes
      .filter((node): node is RailJunctionNode => node.type === 'junction')
      .map((node) => [node.id, 0 as 0 | 1])
  );

  return {
    stageIndex,
    switches,
    trains: [],
    spawnCursor: 0,
    spawnCooldown: 850,
    stageDelivered: 0,
    campaignDelivered,
    score,
    integrity: stage.maxIntegrity,
    combo: 0,
    time: 0,
    bursts: [],
    nextTrainId: 1,
    nextBurstId: 1,
  };
}

function distance(aX: number, aY: number, bX: number, bY: number) {
  return Math.hypot(bX - aX, bY - aY);
}

function getTrainPosition(train: RailTrain, nodeMap: Record<string, RailNode>) {
  const fromNode = nodeMap[train.fromId];
  const toNode = nodeMap[train.toId];
  const x = fromNode.x + (toNode.x - fromNode.x) * train.progress;
  const y = fromNode.y + (toNode.y - fromNode.y) * train.progress;
  return { x, y, angle: Math.atan2(toNode.y - fromNode.y, toNode.x - fromNode.x) };
}

function areTrainsOnSameSegment(first: RailTrain, second: RailTrain) {
  return first.fromId === second.fromId && first.toId === second.toId;
}

function spawnRailTrain(state: RailGameState, stage: RailStageDefinition, nodeMap: Record<string, RailNode>) {
  const plan = stage.spawnPattern[state.spawnCursor % stage.spawnPattern.length];
  const spawnNode = nodeMap[plan.spawnId];
  if (!spawnNode || spawnNode.type !== 'spawn') {
    state.spawnCooldown = stage.spawnIntervalMs;
    return;
  }

  const blocked = state.trains.some((train) => {
    const pos = getTrainPosition(train, nodeMap);
    return distance(pos.x, pos.y, spawnNode.x, spawnNode.y) < 34;
  });

  if (blocked) {
    state.spawnCooldown = 640;
    return;
  }

  state.trains.push({
    id: state.nextTrainId,
    kind: plan.kind,
    fromId: spawnNode.id,
    toId: spawnNode.next[0],
    progress: 0,
    speed: stage.baseSpeed + Math.random() * 12,
  });
  state.nextTrainId += 1;
  state.spawnCursor += 1;
  state.spawnCooldown = stage.spawnIntervalMs * (0.88 + Math.random() * 0.24);
}

function pushRailBurst(state: RailGameState, x: number, y: number, color: string) {
  state.bursts.push({
    id: state.nextBurstId,
    x,
    y,
    color,
    life: 1,
  });
  state.nextBurstId += 1;
}

function drawRailBackground(context: CanvasRenderingContext2D, stage: RailStageDefinition, time: number) {
  const gradient = context.createLinearGradient(0, 0, 0, RAIL_HEIGHT);
  gradient.addColorStop(0, stage.skyTop);
  gradient.addColorStop(1, stage.skyBottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, RAIL_WIDTH, RAIL_HEIGHT);

  context.globalAlpha = 0.6;
  for (let i = 0; i < 4; i += 1) {
    const radius = 64 + i * 18;
    const glow = context.createRadialGradient(
      80 + i * 88,
      42 + Math.sin(time * 0.0012 + i) * 14,
      10,
      80 + i * 88,
      42 + Math.sin(time * 0.0012 + i) * 14,
      radius
    );
    glow.addColorStop(0, i % 2 === 0 ? stage.glowA : stage.glowB);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = glow;
    context.beginPath();
    context.arc(80 + i * 88, 42 + Math.sin(time * 0.0012 + i) * 14, radius, 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;

  if (stage.theme === 'aurora') {
    context.fillStyle = 'rgba(255,255,255,0.26)';
    for (let i = 0; i < 36; i += 1) {
      const x = (i * 29 + time * 0.012) % (RAIL_WIDTH + 40) - 20;
      const y = 24 + (i % 6) * 18;
      context.beginPath();
      context.arc(x, y, (i % 3) + 1.5, 0, Math.PI * 2);
      context.fill();
    }
  }

  if (stage.theme === 'canyon') {
    context.fillStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < 8; i += 1) {
      context.beginPath();
      context.ellipse(
        (i * 58 + time * 0.01) % (RAIL_WIDTH + 80) - 40,
        54 + (i % 2) * 24,
        22,
        8,
        0,
        0,
        Math.PI * 2
      );
      context.fill();
    }
  }

  if (stage.theme === 'harbor') {
    context.fillStyle = 'rgba(255,255,255,0.14)';
    for (let i = 0; i < 10; i += 1) {
      const x = i * 42;
      const y = 166 + Math.sin(time * 0.002 + i) * 4;
      context.fillRect(x, y, 28, 2);
    }
  }

  if (stage.theme === 'obsidian') {
    context.fillStyle = 'rgba(249,115,22,0.12)';
    for (let i = 0; i < 6; i += 1) {
      context.beginPath();
      context.moveTo(i * 66, RAIL_HEIGHT);
      context.lineTo(i * 66 + 20, 180 + Math.sin(time * 0.0015 + i) * 10);
      context.lineTo(i * 66 + 40, RAIL_HEIGHT);
      context.closePath();
      context.fill();
    }
  }

  context.fillStyle = stage.terrainA;
  context.beginPath();
  context.moveTo(0, RAIL_HEIGHT);
  for (let x = 0; x <= RAIL_WIDTH; x += 36) {
    const crest = stage.theme === 'harbor'
      ? 184 + Math.sin(x * 0.025 + time * 0.0016) * 8
      : 188 + Math.sin(x * 0.03) * 18;
    context.lineTo(x, crest);
  }
  context.lineTo(RAIL_WIDTH, RAIL_HEIGHT);
  context.closePath();
  context.fill();

  context.globalAlpha = 0.55;
  context.fillStyle = stage.terrainB;
  context.beginPath();
  context.moveTo(0, RAIL_HEIGHT);
  for (let x = 0; x <= RAIL_WIDTH; x += 28) {
    const crest = stage.theme === 'obsidian'
      ? 206 + Math.cos(x * 0.025 + time * 0.0018) * 10
      : 208 + Math.cos(x * 0.022) * 14;
    context.lineTo(x, crest);
  }
  context.lineTo(RAIL_WIDTH, RAIL_HEIGHT);
  context.closePath();
  context.fill();
  context.globalAlpha = 1;
}

function drawRailTracks(
  context: CanvasRenderingContext2D,
  stage: RailStageDefinition,
  nodeMap: Record<string, RailNode>,
  switches: Record<string, 0 | 1>
) {
  stage.nodes.forEach((node) => {
    const outgoing = node.type === 'spawn' ? node.next : node.type === 'junction' ? node.next : [];
    outgoing.forEach((targetId, index) => {
      const target = nodeMap[targetId];
      if (!target) {
        return;
      }
      const active = node.type === 'junction' ? switches[node.id] === index : false;
      context.save();
      context.lineCap = 'round';
      context.strokeStyle = active ? 'rgba(255,255,255,0.76)' : stage.trackBase;
      context.lineWidth = active ? 16 : 14;
      context.beginPath();
      context.moveTo(node.x, node.y);
      context.lineTo(target.x, target.y);
      context.stroke();

      context.strokeStyle = stage.rail;
      context.lineWidth = active ? 7 : 6;
      context.beginPath();
      context.moveTo(node.x, node.y);
      context.lineTo(target.x, target.y);
      context.stroke();

      const segmentLength = distance(node.x, node.y, target.x, target.y);
      const sleeperCount = Math.max(3, Math.floor(segmentLength / 26));
      for (let sleeperIndex = 1; sleeperIndex < sleeperCount; sleeperIndex += 1) {
        const t = sleeperIndex / sleeperCount;
        const x = node.x + (target.x - node.x) * t;
        const y = node.y + (target.y - node.y) * t;
        const angle = Math.atan2(target.y - node.y, target.x - node.x) + Math.PI / 2;
        const dx = Math.cos(angle) * 5.5;
        const dy = Math.sin(angle) * 5.5;
        context.strokeStyle = stage.sleeper;
        context.lineWidth = 2.2;
        context.beginPath();
        context.moveTo(x - dx, y - dy);
        context.lineTo(x + dx, y + dy);
        context.stroke();
      }
      context.restore();
    });
  });
}

function drawRailNodes(
  context: CanvasRenderingContext2D,
  stage: RailStageDefinition,
  switches: Record<string, 0 | 1>
) {
  stage.nodes.forEach((node) => {
    const isGoalLoot = node.type === 'goal-loot';
    const isGoalRescue = node.type === 'goal-rescue';
    const isJunction = node.type === 'junction';
    const accent = isGoalLoot
      ? LOOT_COLOR
      : isGoalRescue
        ? RESCUE_COLOR
        : isJunction
          ? '#6366F1'
          : '#334155';

    context.save();
    context.beginPath();
    context.fillStyle = 'rgba(255,255,255,0.9)';
    context.arc(node.x, node.y, isJunction ? 12 : 10, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = isJunction ? 4 : 3;
    context.strokeStyle = accent;
    context.stroke();

    if (isJunction) {
      context.fillStyle = accent;
      context.beginPath();
      context.arc(node.x, node.y, 3.6, 0, Math.PI * 2);
      context.fill();
      const activeDir = switches[node.id] === 0 ? -1 : 1;
      context.strokeStyle = accent;
      context.lineWidth = 2.2;
      context.beginPath();
      context.moveTo(node.x, node.y - 18);
      context.lineTo(node.x + activeDir * 8, node.y - 10);
      context.stroke();
    }

    const labelWidth = Math.max(38, node.label.length * 6.8);
    context.fillStyle = 'rgba(255,255,255,0.92)';
    context.strokeStyle = 'rgba(148,163,184,0.35)';
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(node.x - labelWidth / 2, node.y + 13, labelWidth, 18, 9);
    context.fill();
    context.stroke();
    context.fillStyle = '#334155';
    context.font = '600 10px Inter, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(node.label, node.x, node.y + 22.5);
    context.restore();
  });
}

function drawRailTrain(context: CanvasRenderingContext2D, train: RailTrain, nodeMap: Record<string, RailNode>, time: number) {
  const { x, y, angle } = getTrainPosition(train, nodeMap);
  const baseColor = train.kind === 'loot' ? LOOT_COLOR : RESCUE_COLOR;
  const bodyColor = train.kind === 'loot' ? '#FED7AA' : '#BAE6FD';

  context.save();
  context.translate(x, y);
  context.rotate(angle);
  context.shadowColor = `${baseColor}66`;
  context.shadowBlur = 14;
  context.fillStyle = baseColor;
  context.beginPath();
  context.roundRect(-18, -9, 36, 18, 8);
  context.fill();

  context.shadowBlur = 0;
  context.fillStyle = bodyColor;
  context.beginPath();
  context.roundRect(-12, -6, 18, 12, 5);
  context.fill();

  context.fillStyle = '#0F172A';
  context.beginPath();
  context.arc(10, -5, 2, 0, Math.PI * 2);
  context.arc(10, 5, 2, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = 'rgba(255,255,255,0.9)';
  context.fillRect(-7, -3, 4, 3);
  context.fillRect(-1, -3, 4, 3);

  context.strokeStyle = 'rgba(255,255,255,0.7)';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(-17, 0);
  context.lineTo(-22 - Math.sin(time * 0.008 + train.id) * 2, 0);
  context.stroke();
  context.restore();
}

function stepRailGame(
  state: RailGameState,
  stage: RailStageDefinition,
  nodeMap: Record<string, RailNode>,
  dt: number
) {
  state.time += dt;
  state.spawnCooldown -= dt;
  if (state.spawnCooldown <= 0) {
    spawnRailTrain(state, stage, nodeMap);
  }

  const removal = new Set<number>();
  const notices: string[] = [];
  let deliveredDelta = 0;

  state.trains.forEach((train) => {
    if (removal.has(train.id)) {
      return;
    }
    const fromNode = nodeMap[train.fromId];
    const toNode = nodeMap[train.toId];
    const segmentLength = Math.max(1, distance(fromNode.x, fromNode.y, toNode.x, toNode.y));
    train.progress += (train.speed * dt) / 1000 / segmentLength;

    while (train.progress >= 1 && !removal.has(train.id)) {
      train.progress -= 1;
      const arrivalNode = nodeMap[train.toId];
      if (arrivalNode.type === 'goal-loot' || arrivalNode.type === 'goal-rescue') {
        const success = (
          (arrivalNode.type === 'goal-loot' && train.kind === 'loot')
          || (arrivalNode.type === 'goal-rescue' && train.kind === 'rescue')
        );

        if (success) {
          deliveredDelta += 1;
          state.stageDelivered += 1;
          state.campaignDelivered += 1;
          state.combo += 1;
          state.score += 140 + (state.combo - 1) * 35;
          pushRailBurst(state, arrivalNode.x, arrivalNode.y, train.kind === 'loot' ? LOOT_COLOR : RESCUE_COLOR);
          notices.push(train.kind === 'loot' ? 'רכבת שלל נכנסה למנהרה.' : 'רכבת חילוץ הגיעה לנמל.');
        } else {
          state.combo = 0;
          state.integrity -= 1;
          pushRailBurst(state, arrivalNode.x, arrivalNode.y, '#FB7185');
          notices.push('רכבת נותבה למסילה הלא נכונה.');
        }
        removal.add(train.id);
        break;
      }

      if (arrivalNode.type === 'spawn') {
        removal.add(train.id);
        break;
      }

      const outgoing = arrivalNode.next[state.switches[arrivalNode.id] ?? 0];
      train.fromId = arrivalNode.id;
      train.toId = outgoing;
    }
  });

  for (let i = 0; i < state.trains.length; i += 1) {
    for (let j = i + 1; j < state.trains.length; j += 1) {
      const first = state.trains[i];
      const second = state.trains[j];
      if (removal.has(first.id) || removal.has(second.id)) {
        continue;
      }

      if (areTrainsOnSameSegment(first, second)) {
        const leading = first.progress >= second.progress ? first : second;
        const trailing = leading === first ? second : first;
        const gap = leading.progress - trailing.progress;
        if (gap < 0.15) {
          trailing.progress = Math.max(0, leading.progress - 0.15);
        }
        continue;
      }

      const a = getTrainPosition(first, nodeMap);
      const b = getTrainPosition(second, nodeMap);
      if (distance(a.x, a.y, b.x, b.y) < 16) {
        state.integrity -= 1;
        state.combo = 0;
        pushRailBurst(state, (a.x + b.x) / 2, (a.y + b.y) / 2, '#FB7185');
        removal.add(first.id);
        removal.add(second.id);
        notices.push('התנגשות מסילות. צריך סוויץ׳ מוקדם יותר.');
      }
    }
  }

  state.trains = state.trains.filter((train) => !removal.has(train.id));
  state.bursts = state.bursts
    .map((burst) => ({ ...burst, life: burst.life - dt / 520 }))
    .filter((burst) => burst.life > 0);

  return {
    deliveredDelta,
    notice: notices[notices.length - 1] || null,
    stageWon: state.stageDelivered >= stage.targetDeliveries,
    stageLost: state.integrity <= 0,
  };
}

export function RailHeistDialog({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const stateRef = useRef<RailGameState>(createRailState(0));
  const [isPaused, setIsPaused] = useState(false);
  const [isGameOver, setIsGameOver] = useState(false);
  const [isCampaignComplete, setIsCampaignComplete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [integrity, setIntegrity] = useState(RAIL_STAGES[0].maxIntegrity);
  const [stageDelivered, setStageDelivered] = useState(0);
  const [campaignDelivered, setCampaignDelivered] = useState(0);
  const [combo, setCombo] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const [topStatus, setTopStatus] = useState('Rail Heist');

  const stage = useMemo(() => RAIL_STAGES[stageIndex] ?? RAIL_STAGES[0], [stageIndex]);
  const nodeMap = useMemo(() => getNodeMap(stage), [stage]);
  const junctions = useMemo(
    () => stage.nodes.filter((node): node is RailJunctionNode => node.type === 'junction'),
    [stage]
  );

  const syncHud = useEffectEvent(() => {
    const snapshot = stateRef.current;
    setScore(snapshot.score);
    setIntegrity(snapshot.integrity);
    setStageDelivered(snapshot.stageDelivered);
    setCampaignDelivered(snapshot.campaignDelivered);
    setCombo(snapshot.combo);
    setStageIndex(snapshot.stageIndex);
  });

  const resetCampaign = useEffectEvent(() => {
    stateRef.current = createRailState(0);
    lastFrameRef.current = null;
    setIsPaused(false);
    setIsGameOver(false);
    setIsCampaignComplete(false);
    setNotice(null);
    setTopStatus('Rail Heist');
    syncHud();
  });

  const advanceStage = useEffectEvent(() => {
    const snapshot = stateRef.current;
    if (snapshot.stageIndex >= RAIL_STAGES.length - 1) {
      setIsCampaignComplete(true);
      setTopStatus('המסילה שלך שלטה בכל הקמפיין');
      return;
    }

    stateRef.current = createRailState(snapshot.stageIndex + 1, snapshot.score, snapshot.campaignDelivered);
    setIsPaused(false);
    setIsGameOver(false);
    setNotice(`עולה ל-${RAIL_STAGES[snapshot.stageIndex + 1].title}`);
    setTopStatus('הקמפיין ממשיך למסילה הבאה');
    syncHud();
  });

  const toggleJunction = useEffectEvent((junctionId: string) => {
    const snapshot = stateRef.current;
    const current = snapshot.switches[junctionId] ?? 0;
    snapshot.switches[junctionId] = current === 0 ? 1 : 0;
    const junction = nodeMap[junctionId];
    if (junction && junction.type === 'junction') {
      setNotice(`סוויץ׳ ${junction.label} עבר ל-${junction.branchLabels[snapshot.switches[junctionId]]}`);
    }
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
    drawRailBackground(context, stage, snapshot.time);
    drawRailTracks(context, stage, nodeMap, snapshot.switches);
    drawRailNodes(context, stage, snapshot.switches);
    snapshot.trains.forEach((train) => drawRailTrain(context, train, nodeMap, snapshot.time));

    snapshot.bursts.forEach((burst) => {
      context.save();
      context.globalAlpha = burst.life;
      context.strokeStyle = burst.color;
      context.lineWidth = 3;
      context.beginPath();
      context.arc(burst.x, burst.y, 10 + (1 - burst.life) * 16, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    });

    const vignette = context.createLinearGradient(0, 0, 0, RAIL_HEIGHT);
    vignette.addColorStop(0, 'rgba(15,23,42,0.02)');
    vignette.addColorStop(1, 'rgba(15,23,42,0.18)');
    context.fillStyle = vignette;
    context.fillRect(0, 0, RAIL_WIDTH, RAIL_HEIGHT);
  });

  const animate = useEffectEvent((frameTime: number) => {
    if (!isOpen) {
      return;
    }

    const lastFrame = lastFrameRef.current ?? frameTime;
    const dt = Math.min(42, frameTime - lastFrame);
    lastFrameRef.current = frameTime;

    if (!isPaused && !isGameOver && !isCampaignComplete) {
      const stepResult = stepRailGame(stateRef.current, stage, nodeMap, dt);
      if (stepResult.notice) {
        setNotice(stepResult.notice);
      }
      if (stepResult.stageWon) {
        if (stateRef.current.stageIndex >= RAIL_STAGES.length - 1) {
          setIsCampaignComplete(true);
          setTopStatus('השלל יצא מכל ארבע המסילות');
          setNotice('הקמפיין הושלם. אתה מחזיק את כל הרשת.');
        } else {
          setIsPaused(true);
          setTopStatus('השלב נפתח למסילה הבאה');
          setNotice('השלב הושלם. המשך למסילה הבאה.');
        }
      }
      if (stepResult.stageLost) {
        setIsGameOver(true);
        setTopStatus('המסילה קרסה');
        setNotice('איבדת את השליטה על הקווים. מאפסים ומנסים שוב.');
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        event.preventDefault();
        setIsPaused((current) => !current);
        return;
      }
      if (event.key >= '1' && event.key <= '9') {
        const junction = junctions[Number(event.key) - 1];
        if (junction) {
          event.preventDefault();
          toggleJunction(junction.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    animationRef.current = window.requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (animationRef.current) {
        window.cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      lastFrameRef.current = null;
    };
  }, [animate, isOpen, junctions, resetCampaign, toggleJunction]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setTopStatus(stage.title);
  }, [isOpen, stage.title]);

  if (!isOpen) {
    return null;
  }

  const handleCanvasPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    const junction = junctions.find((node) => distance(node.x, node.y, x, y) <= 20);
    if (junction) {
      toggleJunction(junction.id);
    }
  };

  return (
    <div className="fixed inset-0 z-[77] flex items-end justify-center bg-slate-950/32 p-4 backdrop-blur-sm sm:items-center">
      <button
        type="button"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
        aria-label="Close Rail Heist"
      />
      <div className="relative z-10 flex max-h-[90dvh] w-full max-w-xl flex-col overflow-y-auto rounded-[2rem] border border-slate-100 bg-white shadow-[0_34px_100px_-38px_rgba(15,23,42,0.45)]">
        <div className="border-b border-slate-100 bg-gradient-to-b from-slate-50 via-white to-white px-5 py-4 text-right">
          <div className="flex items-start justify-between gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[1.25rem] bg-gradient-to-br from-amber-100 via-white to-cyan-100 text-amber-600 shadow-sm">
              <TrainFront className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                Premium Arcade
              </div>
              <div className="mt-1 text-lg font-semibold text-slate-800">Rail Heist</div>
              <div className="mt-1 text-sm leading-6 text-slate-500">
                {stage.subtitle}
              </div>
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
              <div className="mt-1 text-sm font-semibold text-slate-800">{stage.title}</div>
            </div>
            <div className="rounded-[1.1rem] border border-amber-100 bg-amber-50/80 px-3 py-2">
              <div className="text-[10px] text-amber-500">שלל</div>
              <div className="mt-1 text-sm font-semibold text-amber-700">{stageDelivered} / {stage.targetDeliveries}</div>
            </div>
            <div className="rounded-[1.1rem] border border-emerald-100 bg-emerald-50/80 px-3 py-2">
              <div className="text-[10px] text-emerald-500">נמסרו</div>
              <div className="mt-1 text-sm font-semibold text-emerald-700">{campaignDelivered}</div>
            </div>
            <div className="rounded-[1.1rem] border border-rose-100 bg-rose-50/80 px-3 py-2">
              <div className="text-[10px] text-rose-500">יציבות</div>
              <div className="mt-1 text-sm font-semibold text-rose-700">{integrity}</div>
            </div>
          </div>

          <div className="overflow-hidden rounded-[1.75rem] border border-slate-100 bg-slate-950 shadow-[0_26px_72px_-36px_rgba(15,23,42,0.56)]">
            <canvas
              ref={canvasRef}
              width={RAIL_WIDTH}
              height={RAIL_HEIGHT}
              onPointerDown={handleCanvasPointerDown}
              className="block h-auto w-full touch-none bg-slate-950"
            />
          </div>

          <div className="rounded-[1.35rem] border border-slate-100 bg-white/90 px-4 py-3 shadow-[0_20px_50px_-40px_rgba(15,23,42,0.32)]">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{topStatus}</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">
                  {notice ?? 'הקש על הצמתים או על כרטיסי הסוויץ׳ כדי לנתב כל רכבת ליעד שלה.'}
                </div>
              </div>
              <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                קומבו {combo}
              </div>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {junctions.map((junction, index) => {
              const activeIndex = stateRef.current.switches[junction.id] ?? 0;
              return (
                <button
                  key={junction.id}
                  type="button"
                  onClick={() => toggleJunction(junction.id)}
                  className="rounded-[1.35rem] border border-slate-100 bg-gradient-to-br from-white via-slate-50 to-sky-50 px-3 py-3 text-right shadow-[0_18px_42px_-36px_rgba(15,23,42,0.28)] transition hover:-translate-y-0.5 hover:border-sky-200"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-slate-800">סוויץ׳ {index + 1} · {junction.label}</div>
                    <div className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-500">
                      {activeIndex === 0 ? 'מסלול A' : 'מסלול B'}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                    {junction.branchLabels.map((label, optionIndex) => (
                      <div
                        key={label}
                        className={cn(
                          'rounded-[0.95rem] border px-2.5 py-2 text-center font-semibold transition',
                          activeIndex === optionIndex
                            ? 'border-sky-200 bg-sky-50 text-sky-700'
                            : 'border-slate-100 bg-white text-slate-500'
                        )}
                      >
                        {label}
                      </div>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-slate-400">
              ניקוד {score.toLocaleString('en-US')}
            </div>
            <div className="flex items-center gap-2">
              {isPaused && !isGameOver && !isCampaignComplete && stageDelivered >= stage.targetDeliveries && (
                <button
                  type="button"
                  onClick={() => advanceStage()}
                  className="rounded-full bg-gradient-to-r from-amber-100 via-rose-100 to-sky-100 px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm transition hover:from-amber-200 hover:to-sky-200"
                >
                  למסילה הבאה
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
              <button
                type="button"
                onClick={() => setIsPaused((current) => !current)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              >
                {isPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={() => resetCampaign()}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
