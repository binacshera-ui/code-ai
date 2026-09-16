import { memo, useEffect, useMemo, useState } from 'react';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Bot,
  Box,
  Check,
  CircleHelp,
  Download,
  ExternalLink,
  FileCode2,
  GitBranch,
  Layers3,
  Loader2,
  Map as MapIcon,
  Maximize2,
  Minimize2,
  Network,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  createEmptyFlowDocument,
  type FlowConnectionEdge,
  type FlowDocument,
  type FlowEdgeKind,
  type FlowEvidence,
  type FlowEvidenceKind,
  type FlowModuleNode,
  type FlowNodeKind,
  type FlowNodeStatus,
  type FlowOwnershipKind,
  type FlowVisualGroup,
} from '../../../../shared/flowMode';

export type FlowModeDetail = 'simple' | 'balanced' | 'deep';

export interface CodexSessionFlowModeValue {
  enabled: boolean;
  detail: FlowModeDetail;
  brief: string;
  document: FlowDocument | null;
  revision: number;
  updatedAt: string | null;
  lastGeneratedAt: string | null;
  source: 'agent' | 'user' | null;
}

type ModuleNodeData = {
  module: FlowModuleNode;
  group: FlowVisualGroup | null;
  dimmed: boolean;
};
type ModuleCanvasNode = Node<ModuleNodeData, 'flowModule'>;
type ModuleCanvasEdge = Edge<{ connection: FlowConnectionEdge }>;

const OWNERSHIP_META: Record<FlowOwnershipKind, { label: string; className: string; dot: string }> = {
  repository: { label: 'נמצא בריפו', className: 'border-sky-200 bg-sky-50 text-sky-800', dot: '#38bdf8' },
  external: { label: 'שירות חיצוני', className: 'border-violet-200 bg-violet-50 text-violet-800', dot: '#a78bfa' },
  managed: { label: 'שירות מנוהל', className: 'border-emerald-200 bg-emerald-50 text-emerald-800', dot: '#34d399' },
  infrastructure: { label: 'תשתית', className: 'border-amber-200 bg-amber-50 text-amber-800', dot: '#fbbf24' },
  unknown: { label: 'עדיין לא ידוע', className: 'border-slate-200 bg-slate-50 text-slate-700', dot: '#94a3b8' },
};

const NODE_KIND_LABELS: Record<FlowNodeKind, string> = {
  system: 'מערכת',
  ui: 'ממשק',
  api: 'API',
  service: 'שירות',
  worker: 'עובד רקע',
  database: 'מסד נתונים',
  queue: 'תור',
  container: 'קונטיינר',
  external: 'חיצוני',
  file: 'קובץ',
  decision: 'החלטה',
  person: 'אדם',
  other: 'אחר',
};

const STATUS_LABELS: Record<FlowNodeStatus, string> = {
  active: 'פעיל',
  planned: 'מתוכנן',
  risk: 'דורש תשומת לב',
  unknown: 'לא ידוע',
};

const EDGE_KIND_LABELS: Record<FlowEdgeKind, string> = {
  data: 'מידע',
  request: 'בקשה',
  event: 'אירוע',
  dependency: 'תלות',
  control: 'שליטה',
  deploy: 'פריסה',
  other: 'חיבור',
};

const EVIDENCE_KIND_LABELS: Record<FlowEvidenceKind, string> = {
  path: 'נתיב',
  url: 'קישור',
  runtime: 'ריצה',
  note: 'הערה',
};

const GROUP_COLORS: Record<FlowVisualGroup['color'], string> = {
  sky: '#e0f2fe',
  mint: '#d1fae5',
  violet: '#ede9fe',
  rose: '#ffe4e6',
  amber: '#fef3c7',
  slate: '#f1f5f9',
};

function randomId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function autoLayout(document: FlowDocument): FlowDocument {
  const indegree = new Map(document.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(document.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of document.edges) {
    if (!indegree.has(edge.source) || !indegree.has(edge.target)) continue;
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const level = new Map<string, number>();
  const queue = document.nodes.filter((node) => (indegree.get(node.id) || 0) === 0).map((node) => node.id);
  if (queue.length === 0 && document.nodes[0]) queue.push(document.nodes[0].id);
  for (const id of queue) level.set(id, 0);
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor++];
    const currentLevel = level.get(current) || 0;
    for (const target of outgoing.get(current) || []) {
      level.set(target, Math.max(level.get(target) || 0, currentLevel + 1));
      indegree.set(target, Math.max(0, (indegree.get(target) || 0) - 1));
      if (indegree.get(target) === 0) queue.push(target);
    }
  }
  for (const node of document.nodes) {
    if (!level.has(node.id)) level.set(node.id, Math.max(0, ...level.values()) + 1);
  }

  const rowsByLevel = new Map<number, FlowModuleNode[]>();
  for (const node of document.nodes) {
    const nodeLevel = level.get(node.id) || 0;
    rowsByLevel.set(nodeLevel, [...(rowsByLevel.get(nodeLevel) || []), node]);
  }
  const rtlMultiplier = document.direction === 'rtl' ? -1 : 1;
  const nextNodes = document.nodes.map((node) => {
    const nodeLevel = level.get(node.id) || 0;
    const row = rowsByLevel.get(nodeLevel) || [];
    const rowIndex = row.findIndex((candidate) => candidate.id === node.id);
    const totalHeight = Math.max(0, row.length - 1) * 190;
    return {
      ...node,
      position: {
        x: nodeLevel * 360 * rtlMultiplier,
        y: rowIndex * 190 - totalHeight / 2,
      },
    };
  });
  return { ...document, nodes: nextNodes, updatedAt: new Date().toISOString() };
}

function toCanvasNodes(document: FlowDocument, query: string): ModuleCanvasNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase('he');
  const groups = new Map(document.groups.map((group) => [group.id, group]));
  const positioned = document.nodes.every((node) => node.position) ? document : autoLayout(document);
  return positioned.nodes.map((module) => ({
    id: module.id,
    type: 'flowModule',
    position: module.position || { x: 0, y: 0 },
    data: {
      module,
      group: module.groupId ? groups.get(module.groupId) || null : null,
      dimmed: Boolean(normalizedQuery && ![
        module.title,
        module.summary,
        module.description,
        module.technology,
        module.runtime,
        module.repositoryPath,
        ...module.tags,
      ].join(' ').toLocaleLowerCase('he').includes(normalizedQuery)),
    },
  }));
}

function toCanvasEdges(document: FlowDocument): ModuleCanvasEdge[] {
  return document.edges.map((connection) => ({
    id: connection.id,
    source: connection.source,
    target: connection.target,
    label: connection.label || undefined,
    data: { connection },
    type: 'smoothstep',
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: '#94a3b8' },
    style: { stroke: '#94a3b8', strokeWidth: 1.6 },
    labelStyle: { fill: '#475569', fontSize: 11, fontWeight: 600 },
    labelBgStyle: { fill: '#ffffff', fillOpacity: 0.92 },
    labelBgPadding: [6, 4],
    labelBgBorderRadius: 8,
  }));
}

const FlowModuleCard = memo(function FlowModuleCard({ data, selected }: NodeProps<ModuleCanvasNode>) {
  const meta = OWNERSHIP_META[data.module.ownership];
  const statusTone = data.module.status === 'risk'
    ? 'bg-rose-100 text-rose-700'
    : data.module.status === 'planned'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-white/80 text-slate-500';
  return (
    <div
      dir="rtl"
      className={cn(
        'w-[17.5rem] rounded-[1.45rem] border bg-white/95 p-3.5 text-right shadow-[0_18px_45px_-32px_rgba(15,23,42,0.42)] transition duration-200',
        selected ? 'border-cyan-400 ring-4 ring-cyan-100/80' : 'border-slate-200/90',
        data.dimmed && 'opacity-25 grayscale',
      )}
      style={{ boxShadow: data.group ? `0 18px 45px -32px ${GROUP_COLORS[data.group.color]}` : undefined }}
    >
      <Handle type="target" position={Position.Right} className="!h-3 !w-3 !border-2 !border-white !bg-slate-400" />
      <Handle type="source" position={Position.Left} className="!h-3 !w-3 !border-2 !border-white !bg-cyan-500" />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={cn('rounded-full border px-2 py-0.5 text-[9px] font-semibold', meta.className)}>{meta.label}</span>
            <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-semibold', statusTone)}>{STATUS_LABELS[data.module.status]}</span>
          </div>
          <div className="mt-2 text-[15px] font-black leading-6 text-slate-800">{data.module.title}</div>
        </div>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl" style={{ backgroundColor: data.group ? GROUP_COLORS[data.group.color] : '#ecfeff', color: meta.dot }}>
          {data.module.kind === 'file' ? <FileCode2 className="h-5 w-5" /> : data.module.kind === 'system' ? <Network className="h-5 w-5" /> : <Box className="h-5 w-5" />}
        </div>
      </div>
      <div className="mt-2 line-clamp-3 text-[11px] leading-5 text-slate-500">{data.module.summary || data.module.description || 'לחץ כדי להוסיף הסבר למודול.'}</div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 text-[9px] text-slate-400">
        <span>{NODE_KIND_LABELS[data.module.kind]}</span>
        <span className="max-w-[9rem] truncate" dir="ltr">{data.module.technology || data.module.runtime || data.module.repositoryPath || '—'}</span>
      </div>
    </div>
  );
});

const nodeTypes = { flowModule: FlowModuleCard };

function TextField({ label, value, onChange, dir = 'rtl', placeholder }: { label: string; value: string; onChange: (value: string) => void; dir?: 'rtl' | 'ltr'; placeholder?: string }) {
  return (
    <label className="block text-right">
      <span className="text-[10px] font-semibold text-slate-500">{label}</span>
      <input
        dir={dir}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none transition focus:border-cyan-300 focus:ring-4 focus:ring-cyan-100/60"
      />
    </label>
  );
}

function SelectField<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Record<T, string>; onChange: (value: T) => void }) {
  return (
    <label className="block text-right">
      <span className="text-[10px] font-semibold text-slate-500">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)} className="mt-1 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-cyan-300">
        {Object.entries(options).map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{String(optionLabel)}</option>)}
      </select>
    </label>
  );
}

function downloadFlow(document: FlowDocument) {
  const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = `${document.id || 'bina-flow'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function FlowModeDialog({
  isOpen,
  value,
  isSaving,
  onClose,
  onSave,
  onSendToComposer,
}: {
  isOpen: boolean;
  value: CodexSessionFlowModeValue;
  isSaving: boolean;
  onClose: () => void;
  onSave: (next: { enabled: boolean; detail: FlowModeDetail; brief: string; document?: FlowDocument | null; expectedRevision: number }) => Promise<CodexSessionFlowModeValue>;
  onSendToComposer: (prompt: string) => void;
}) {
  const [document, setDocument] = useState<FlowDocument>(() => value.document || createEmptyFlowDocument());
  const [detail, setDetail] = useState<FlowModeDetail>(value.detail);
  const [brief, setBrief] = useState(value.brief);
  const [nodes, setNodes] = useState<ModuleCanvasNode[]>([]);
  const [edges, setEdges] = useState<ModuleCanvasEdge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [agentRequest, setAgentRequest] = useState('');
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [isCanvasOnly, setIsCanvasOnly] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const nextDocument = value.document || createEmptyFlowDocument();
    const laidOut = nextDocument.nodes.some((node) => !node.position) ? autoLayout(nextDocument) : nextDocument;
    setDocument(laidOut);
    setNodes(toCanvasNodes(laidOut, ''));
    setEdges(toCanvasEdges(laidOut));
    setDetail(value.detail);
    setBrief(value.brief);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setQuery('');
    setDirty(false);
    setNotice(null);
    setShowSettings(!value.enabled && !value.document);
    setIsCanvasOnly(false);
  }, [isOpen, value.revision]);

  useEffect(() => {
    setNodes((current) => current.map((node) => ({
      ...node,
      data: toCanvasNodes({ ...document, nodes: [node.data.module] }, query)[0]?.data || node.data,
    })));
  }, [query]);

  const selectedNode = useMemo(() => document.nodes.find((node) => node.id === selectedNodeId) || null, [document.nodes, selectedNodeId]);
  const selectedEdge = useMemo(() => document.edges.find((edge) => edge.id === selectedEdgeId) || null, [document.edges, selectedEdgeId]);

  const syncDocumentFromCanvas = (base = document): FlowDocument => ({
    ...base,
    nodes: base.nodes.map((module) => {
      const canvasNode = nodes.find((node) => node.id === module.id);
      return canvasNode ? { ...module, position: canvasNode.position } : module;
    }),
    edges: edges.map((edge) => edge.data?.connection || {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: typeof edge.label === 'string' ? edge.label : '',
      description: '',
      kind: 'other',
    }),
    updatedAt: new Date().toISOString(),
  });

  const updateNode = (patch: Partial<FlowModuleNode>) => {
    if (!selectedNodeId) return;
    setDocument((current) => {
      const next = { ...current, nodes: current.nodes.map((node) => node.id === selectedNodeId ? { ...node, ...patch } : node) };
      const updated = next.nodes.find((node) => node.id === selectedNodeId)!;
      setNodes((canvasNodes) => canvasNodes.map((node) => node.id === selectedNodeId ? { ...node, data: { ...node.data, module: updated } } : node));
      return next;
    });
    setDirty(true);
  };

  const updateEdge = (patch: Partial<FlowConnectionEdge>) => {
    if (!selectedEdgeId) return;
    setDocument((current) => {
      const next = { ...current, edges: current.edges.map((edge) => edge.id === selectedEdgeId ? { ...edge, ...patch } : edge) };
      const updated = next.edges.find((edge) => edge.id === selectedEdgeId)!;
      setEdges((canvasEdges) => canvasEdges.map((edge) => edge.id === selectedEdgeId ? { ...edge, label: updated.label || undefined, data: { connection: updated } } : edge));
      return next;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    try {
      const nextDocument = syncDocumentFromCanvas();
      const saved = await onSave({ enabled: true, detail, brief, document: nextDocument, expectedRevision: value.revision });
      setDocument(saved.document || nextDocument);
      setDirty(false);
      setNotice('הזרימה נשמרה. הסוכן יקבל את הגרסה הזאת בהודעה הבאה.');
      return true;
    } catch (error: any) {
      setNotice(error?.message || 'השמירה נכשלה. הזרימה המקומית נשארה פתוחה.');
      return false;
    }
  };

  const enableMode = async () => {
    try {
      await onSave({
        enabled: true,
        detail,
        brief,
        document: syncDocumentFromCanvas(),
        expectedRevision: value.revision,
      });
      setNotice('מצב יצירת זרימה פעיל. בקש מהסוכן למפות מערכת או תהליך.');
      setShowSettings(false);
    } catch (error: any) {
      setNotice(error?.message || 'לא ניתן היה להפעיל את המצב.');
    }
  };

  const disableMode = async () => {
    try {
      await onSave({ enabled: false, detail, brief, expectedRevision: value.revision });
      onClose();
    } catch (error: any) {
      setNotice(error?.message || 'לא ניתן היה לכבות את המצב.');
    }
  };

  const addModule = () => {
    const id = randomId('module');
    const module: FlowModuleNode = {
      id,
      title: 'מודול חדש',
      summary: 'מה התפקיד של המודול הזה?',
      description: '',
      kind: 'service',
      ownership: 'unknown',
      status: 'planned',
      groupId: null,
      technology: '',
      runtime: '',
      repositoryPath: '',
      externalUrl: '',
      tags: [],
      evidence: [],
      position: { x: 0, y: document.nodes.length * 80 },
    };
    setDocument((current) => ({ ...current, nodes: [...current.nodes, module] }));
    setNodes((current) => [...current, { id, type: 'flowModule', position: module.position!, data: { module, group: null, dimmed: false } }]);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setDirty(true);
  };

  const deleteNode = () => {
    if (!selectedNodeId) return;
    setDocument((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== selectedNodeId),
      edges: current.edges.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId),
    }));
    setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
    setDirty(true);
  };

  const deleteEdge = () => {
    if (!selectedEdgeId) return;
    setDocument((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== selectedEdgeId) }));
    setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
    setSelectedEdgeId(null);
    setDirty(true);
  };

  const resetLayout = () => {
    const next = autoLayout({ ...document, nodes: document.nodes.map((node) => ({ ...node, position: null })) });
    setDocument(next);
    setNodes(toCanvasNodes(next, query));
    setDirty(true);
  };

  const handoffToAgent = async () => {
    const request = agentRequest.trim();
    if (!request) return;
    if (dirty) {
      if (!await handleSave()) return;
    }
    const selectedContext = selectedNode
      ? `אני מתייחס למודול "${selectedNode.title}" (id: ${selectedNode.id}).`
      : selectedEdge
        ? `אני מתייחס לחיבור "${selectedEdge.label || selectedEdge.id}" (id: ${selectedEdge.id}).`
        : 'אני מתייחס לזרימה כולה.';
    onSendToComposer(`${selectedContext}\n\n${request}\n\nהשתמש בזרימה הקנונית העדכנית של מצב יצירת הזרימה, בצע את הבדיקה או עבודת הקוד הנדרשת, ובסוף עדכן את הזרימה כך שתשקף את המצב האמיתי.`);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[110] flex min-h-0 flex-col overflow-hidden bg-[#f8fafc]" dir="rtl">
      {!isCanvasOnly && <header className="relative z-20 flex min-h-[4.5rem] flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 bg-white/95 px-3 py-3 shadow-sm backdrop-blur-xl sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50" aria-label="סגור את הזרימה"><X className="h-5 w-5" /></button>
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-cyan-100 to-violet-100 text-cyan-700"><Network className="h-5 w-5" /></div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-base font-black text-slate-850 sm:text-lg">{document.title || 'מצב יצירת זרימה'}</h2>
              {value.enabled && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[9px] font-semibold text-emerald-700">פעיל</span>}
              {dirty && <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[9px] font-semibold text-amber-700">יש שינויים</span>}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-slate-400">{document.nodes.length} מודולים · {document.edges.length} חיבורים · גרסה {value.revision}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {document.nodes.length > 0 && <button type="button" onClick={() => setIsCanvasOnly(true)} className="flex h-11 items-center gap-2 rounded-full border border-teal-200 bg-teal-50 px-3 text-xs font-semibold text-teal-700 transition hover:bg-teal-100" title="פתח רק את הזרימה על כל המסך"><Maximize2 className="h-4 w-4" /><span className="hidden sm:inline">רק הזרימה</span></button>}
          <button type="button" onClick={() => setShowSettings((current) => !current)} className="flex h-11 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"><Settings2 className="h-4 w-4" /><span className="hidden sm:inline">הגדרות</span></button>
          {document.nodes.length > 0 && <button type="button" onClick={() => downloadFlow(syncDocumentFromCanvas())} className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50" title="הורד JSON"><Download className="h-4 w-4" /></button>}
          <button type="button" onClick={addModule} className="flex h-11 items-center gap-2 rounded-full border border-cyan-200 bg-cyan-50 px-3 text-xs font-semibold text-cyan-700 transition hover:bg-cyan-100"><Plus className="h-4 w-4" /><span>מודול</span></button>
          <button type="button" onClick={() => void handleSave()} disabled={isSaving || !value.enabled || (!dirty && detail === value.detail && brief === value.brief)} className="flex h-11 items-center gap-2 rounded-full bg-slate-900 px-4 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:cursor-default disabled:opacity-40">
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : dirty ? <Save className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            <span>{isSaving ? 'שומר…' : dirty ? 'שמור זרימה' : 'שמור'}</span>
          </button>
        </div>
      </header>}

      {!isCanvasOnly && notice && <div className="relative z-20 flex items-center justify-between gap-3 border-b border-emerald-100 bg-emerald-50 px-4 py-2 text-xs font-medium text-emerald-800"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}><X className="h-3.5 w-3.5" /></button></div>}

      {!isCanvasOnly && showSettings && (
        <div className="relative z-20 border-b border-violet-100 bg-gradient-to-l from-cyan-50 via-white to-violet-50 px-4 py-4 shadow-sm">
          <div className="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[1fr_1fr_1.4fr_auto] lg:items-end">
            <div className="grid gap-2">
              <TextField label="כותרת המפה" value={document.title} onChange={(title) => { setDocument((current) => ({ ...current, title })); setDirty(true); }} />
              <TextField label="שורת הסבר קצרה" value={document.subtitle} onChange={(subtitle) => { setDocument((current) => ({ ...current, subtitle })); setDirty(true); }} />
            </div>
            <div>
              <div className="mb-2 text-xs font-bold text-slate-700">כמה עמוק להסביר?</div>
              <div className="grid grid-cols-3 gap-2">
                {(['simple', 'balanced', 'deep'] as FlowModeDetail[]).map((option) => <button key={option} type="button" onClick={() => { setDetail(option); setDirty(true); }} className={cn('h-11 rounded-xl border text-xs font-semibold transition', detail === option ? 'border-violet-300 bg-violet-100 text-violet-800' : 'border-slate-200 bg-white text-slate-500')}>{option === 'simple' ? 'פשוט' : option === 'deep' ? 'עמוק' : 'מאוזן'}</button>)}
              </div>
            </div>
            <label className="block text-right">
              <span className="text-xs font-bold text-slate-700">דגש קבוע לסוכן</span>
              <textarea value={brief} onChange={(event) => { setBrief(event.target.value); setDirty(true); }} placeholder="למשל: הראה במיוחד מה רץ בדוקר ומה שירות חיצוני" rows={2} className="mt-2 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-700 outline-none focus:border-violet-300" />
            </label>
            <div className="flex gap-2">
              {!value.enabled ? <button type="button" onClick={() => void enableMode()} disabled={isSaving} className="h-11 rounded-full bg-violet-600 px-5 text-xs font-bold text-white hover:bg-violet-700 disabled:opacity-50">הפעל מצב זרימה</button> : <button type="button" onClick={() => void disableMode()} disabled={isSaving} className="h-11 rounded-full border border-rose-200 bg-white px-4 text-xs font-semibold text-rose-600 hover:bg-rose-50 disabled:opacity-50">כבה מצב</button>}
            </div>
          </div>
        </div>
      )}

      <div className={cn(
        'relative min-h-0 flex-1',
        isCanvasOnly ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:overflow-hidden',
      )} dir="ltr">
        <section className={cn(
          'relative overflow-hidden bg-[radial-gradient(circle_at_20%_15%,rgba(207,250,254,0.7),transparent_28%),radial-gradient(circle_at_80%_85%,rgba(237,233,254,0.75),transparent_30%),#f8fafc]',
          isCanvasOnly ? 'h-full min-h-0' : 'min-h-[58dvh] lg:h-full lg:min-h-0',
        )}>
          <div className="absolute left-3 right-3 top-3 z-10 flex items-center gap-2 sm:left-4 sm:right-auto">
            <label className="flex h-11 flex-1 items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-3 shadow-sm backdrop-blur sm:w-72" dir="rtl">
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="חפש מודול, טכנולוגיה או נתיב" className="min-w-0 flex-1 bg-transparent text-right text-xs text-slate-700 outline-none" />
              {query && <button type="button" onClick={() => setQuery('')}><X className="h-3.5 w-3.5 text-slate-400" /></button>}
            </label>
            <button type="button" onClick={resetLayout} className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-500 shadow-sm transition hover:text-cyan-700" title="סדר מחדש"><RotateCcw className="h-4 w-4" /></button>
            {isCanvasOnly && <button type="button" onClick={() => setIsCanvasOnly(false)} className="flex h-11 shrink-0 items-center gap-2 rounded-full border border-teal-200 bg-white/95 px-3 text-xs font-bold text-teal-700 shadow-sm backdrop-blur transition hover:bg-teal-50" title="חזור למסך העריכה"><Minimize2 className="h-4 w-4" /><span className="hidden sm:inline">חזרה לעריכה</span></button>}
          </div>

          {document.nodes.length === 0 ? (
            <div className="flex h-full min-h-[55dvh] items-center justify-center p-6" dir="rtl">
              <div className="max-w-lg rounded-[2rem] border border-white bg-white/90 p-7 text-center shadow-[0_30px_90px_-50px_rgba(14,116,144,0.45)] backdrop-blur">
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.5rem] bg-gradient-to-br from-cyan-100 to-violet-100 text-cyan-700"><MapIcon className="h-7 w-7" /></div>
                <h3 className="mt-5 text-xl font-black text-slate-800">כאן הקוד יהפוך למפה</h3>
                <p className="mt-3 text-sm leading-7 text-slate-500">הפעל את המצב ובקש מהסוכן להסביר מערכת, תהליך או ריפו. כשהסבב יסתיים, המפה המלאה תופיע כאן ותישאר ניתנת לעריכה.</p>
                {!value.enabled ? <button type="button" onClick={() => setShowSettings(true)} className="mt-5 h-11 rounded-full bg-violet-600 px-5 text-xs font-bold text-white hover:bg-violet-700">הגדר והפעל</button> : <div className="mt-5 rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-700">המצב פעיל. עכשיו שלח בקשה לסוכן מתוך השיחה.</div>}
              </div>
            </div>
          ) : (
            <ReactFlow<ModuleCanvasNode, ModuleCanvasEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={(changes: NodeChange<ModuleCanvasNode>[]) => { setNodes((current) => applyNodeChanges(changes, current)); if (changes.some((change) => change.type === 'position' && !change.dragging)) setDirty(true); }}
              onEdgesChange={(changes: EdgeChange<ModuleCanvasEdge>[]) => { setEdges((current) => applyEdgeChanges(changes, current)); if (changes.some((change) => change.type === 'remove')) { setDocument((current) => ({ ...current, edges: current.edges.filter((edge) => !changes.some((change) => change.type === 'remove' && change.id === edge.id)) })); setDirty(true); } }}
              onConnect={(connection: Connection) => {
                if (!connection.source || !connection.target) return;
                const nextConnection: FlowConnectionEdge = { id: randomId('connection'), source: connection.source, target: connection.target, label: 'מעביר אל', description: '', kind: 'request' };
                setDocument((current) => ({ ...current, edges: [...current.edges, nextConnection] }));
                setEdges((current) => addEdge({ ...connection, id: nextConnection.id, type: 'smoothstep', label: nextConnection.label, data: { connection: nextConnection }, markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' }, style: { stroke: '#94a3b8', strokeWidth: 1.6 } }, current));
                setSelectedEdgeId(nextConnection.id);
                setSelectedNodeId(null);
                setDirty(true);
              }}
              onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
              onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
              onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
              fitView
              fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
              minZoom={0.15}
              maxZoom={1.8}
              snapToGrid
              snapGrid={[16, 16]}
              selectionOnDrag
              multiSelectionKeyCode="Shift"
              deleteKeyCode={null}
              preventScrolling={isCanvasOnly}
              zoomOnScroll={isCanvasOnly}
              panOnDrag
              zoomOnPinch
              colorMode="light"
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#cbd5e1" />
              <Controls position="bottom-left" showInteractive={false} />
              <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => {
                const module = (node.data as ModuleNodeData).module;
                return OWNERSHIP_META[module.ownership].dot;
              }} maskColor="rgba(248,250,252,0.78)" />
            </ReactFlow>
          )}
        </section>

        {!isCanvasOnly && <aside className="min-h-0 overflow-visible border-t border-slate-200 bg-white p-4 lg:overflow-y-auto lg:border-l-0 lg:border-r lg:border-t-0" dir="rtl">
          {selectedNode ? (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div><div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-600">Module</div><h3 className="mt-1 text-base font-black text-slate-800">עריכת מודול</h3></div>
                <button type="button" onClick={deleteNode} className="flex h-10 w-10 items-center justify-center rounded-full border border-rose-100 bg-rose-50 text-rose-600 hover:bg-rose-100" title="מחק מודול"><Trash2 className="h-4 w-4" /></button>
              </div>
              <TextField label="שם פשוט וברור" value={selectedNode.title} onChange={(title) => updateNode({ title })} />
              <TextField label="מה הוא עושה במשפט אחד" value={selectedNode.summary} onChange={(summary) => updateNode({ summary })} />
              <label className="block text-right"><span className="text-[10px] font-semibold text-slate-500">הסבר מלא</span><textarea value={selectedNode.description} onChange={(event) => updateNode({ description: event.target.value })} rows={5} className="mt-1 w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-700 outline-none focus:border-cyan-300" /></label>
              <div className="grid grid-cols-2 gap-2"><SelectField label="סוג" value={selectedNode.kind} options={NODE_KIND_LABELS} onChange={(kind) => updateNode({ kind })} /><SelectField label="בעלות" value={selectedNode.ownership} options={Object.fromEntries(Object.entries(OWNERSHIP_META).map(([id, meta]) => [id, meta.label])) as Record<FlowOwnershipKind, string>} onChange={(ownership) => updateNode({ ownership })} /></div>
              <SelectField label="מצב" value={selectedNode.status} options={STATUS_LABELS} onChange={(status) => updateNode({ status })} />
              <TextField label="טכנולוגיה" value={selectedNode.technology} onChange={(technology) => updateNode({ technology })} placeholder="React, PostgreSQL, Docker…" />
              <TextField label="איפה הוא רץ" value={selectedNode.runtime} onChange={(runtime) => updateNode({ runtime })} placeholder="שרת, קונטיינר, ענן…" />
              <TextField label="נתיב בריפו" value={selectedNode.repositoryPath} onChange={(repositoryPath) => updateNode({ repositoryPath })} dir="ltr" />
              <TextField label="קישור חיצוני" value={selectedNode.externalUrl} onChange={(externalUrl) => updateNode({ externalUrl })} dir="ltr" />
              <TextField label="תגיות — מופרדות בפסיק" value={selectedNode.tags.join(', ')} onChange={(tags) => updateNode({ tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 12) })} />
              {document.groups.length > 0 && <label className="block text-right"><span className="text-[10px] font-semibold text-slate-500">קבוצה במפה</span><select value={selectedNode.groupId || ''} onChange={(event) => updateNode({ groupId: event.target.value || null })} className="mt-1 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-700"><option value="">ללא קבוצה</option>{document.groups.map((group) => <option key={group.id} value={group.id}>{group.title}</option>)}</select></label>}
              <div>
                <div className="mb-2 flex items-center justify-between gap-2"><span className="text-[10px] font-semibold text-slate-500">ראיות והפניות</span><button type="button" onClick={() => updateNode({ evidence: [...selectedNode.evidence, { id: randomId('evidence'), kind: 'note', label: 'ראיה חדשה', value: '' }] })} className="flex h-8 items-center gap-1 rounded-full border border-slate-200 px-2 text-[10px] font-semibold text-slate-500"><Plus className="h-3 w-3" />הוסף</button></div>
                <div className="space-y-2">{selectedNode.evidence.map((evidence, index) => <div key={evidence.id} className="rounded-xl border border-slate-100 bg-slate-50 p-2"><div className="flex gap-2"><select value={evidence.kind} onChange={(event) => { const next = [...selectedNode.evidence]; next[index] = { ...evidence, kind: event.target.value as FlowEvidenceKind }; updateNode({ evidence: next }); }} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-[10px]">{Object.entries(EVIDENCE_KIND_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><input value={evidence.label} onChange={(event) => { const next = [...selectedNode.evidence]; next[index] = { ...evidence, label: event.target.value }; updateNode({ evidence: next }); }} className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-xs" /><button type="button" onClick={() => updateNode({ evidence: selectedNode.evidence.filter((item) => item.id !== evidence.id) })} className="h-9 w-9 text-rose-500"><X className="mx-auto h-3.5 w-3.5" /></button></div><input dir="ltr" value={evidence.value} onChange={(event) => { const next: FlowEvidence[] = [...selectedNode.evidence]; next[index] = { ...evidence, value: event.target.value }; updateNode({ evidence: next }); }} placeholder="path / URL / runtime" className="mt-2 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-left text-xs" /></div>)}</div>
              </div>
            </div>
          ) : selectedEdge ? (
            <div className="space-y-4"><div className="flex items-start justify-between gap-3"><div><div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-600">Connection</div><h3 className="mt-1 text-base font-black text-slate-800">עריכת חיבור</h3></div><button type="button" onClick={deleteEdge} className="flex h-10 w-10 items-center justify-center rounded-full border border-rose-100 bg-rose-50 text-rose-600"><Trash2 className="h-4 w-4" /></button></div><TextField label="מה עובר כאן?" value={selectedEdge.label} onChange={(label) => updateEdge({ label })} /><label className="block text-right"><span className="text-[10px] font-semibold text-slate-500">הסבר החיבור</span><textarea value={selectedEdge.description} onChange={(event) => updateEdge({ description: event.target.value })} rows={4} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" /></label><SelectField label="סוג החיבור" value={selectedEdge.kind} options={EDGE_KIND_LABELS} onChange={(kind) => updateEdge({ kind })} /><div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs leading-6 text-slate-500">{document.nodes.find((node) => node.id === selectedEdge.source)?.title} ← {document.nodes.find((node) => node.id === selectedEdge.target)?.title}</div></div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-[1.5rem] border border-cyan-100 bg-gradient-to-br from-cyan-50 to-white p-4"><div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-cyan-700 shadow-sm"><CircleHelp className="h-5 w-5" /></div><h3 className="mt-3 text-base font-black text-slate-800">לחץ על כל מודול</h3><p className="mt-2 text-xs leading-6 text-slate-500">כאן יופיע ההסבר המלא שהסוכן כתב, המקור שלו, מקום הריצה והראיות שמחברות את המפה לקוד האמיתי.</p></div>
              {document.summary && <div className="rounded-[1.5rem] border border-slate-100 bg-slate-50/80 p-4"><div className="text-[10px] font-semibold text-slate-400">על המפה</div><p className="mt-2 text-xs leading-6 text-slate-600">{document.summary}</p></div>}
              <div className="rounded-[1.5rem] border border-violet-100 bg-violet-50/60 p-4"><div className="flex items-center gap-2 text-xs font-bold text-violet-800"><GitBranch className="h-4 w-4" />איך עורכים?</div><ul className="mt-2 space-y-1 text-[11px] leading-5 text-violet-700/80"><li>• גרור מודולים כדי לסדר את המפה.</li><li>• גרור מהנקודה הכחולה לאפורה כדי לחבר.</li><li>• הוסף מודול מהכפתור למעלה.</li><li>• שמור לפני שמבקשים מהסוכן שינוי.</li></ul></div>
            </div>
          )}

          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="flex items-center gap-2 text-xs font-black text-slate-800"><Bot className="h-4 w-4 text-violet-600" />שאל או בקש שינוי</div>
            <textarea value={agentRequest} onChange={(event) => setAgentRequest(event.target.value)} rows={4} placeholder={selectedNode ? `מה תרצה לדעת או לשנות ב־${selectedNode.title}?` : 'למשל: הוסף את שכבת האימות ובדוק איפה היא באמת נמצאת בקוד'} className="mt-2 w-full resize-y rounded-xl border border-slate-200 bg-slate-50/70 px-3 py-2 text-sm leading-6 text-slate-700 outline-none focus:border-violet-300 focus:bg-white" />
            <button type="button" onClick={() => void handoffToAgent()} disabled={!agentRequest.trim() || isSaving} className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-violet-600 px-4 text-xs font-bold text-white transition hover:bg-violet-700 disabled:opacity-40"><Send className="h-4 w-4" />העבר לתיבת ההודעה</button>
            <p className="mt-2 text-center text-[9px] leading-4 text-slate-400">הסוכן יקבל אוטומטית את כל הזרימה העדכנית, לא רק את המודול הנבחר.</p>
          </div>
        </aside>}
      </div>
    </div>
  );
}
