import { promises as fs } from 'fs';
import path from 'path';
import { CODEX_APP_CONFIG, type AppProvider } from './config.js';
import type { CodexPermissionSnapshot, CodexProfile } from './codexService.js';

export interface ProviderPermissionModeOption {
  id: string;
  label: string;
  accessLevel: 'full' | 'balanced' | 'restricted';
  modeLabel: string;
  summary: string;
  description: string;
  approvalLabel: string | null;
  sandboxLabel: string | null;
  toolsLabel: string | null;
  trustLabel: string | null;
}

export interface ProviderPermissionCapabilities {
  canChangeMode: boolean;
  detectsLiveApprovalRequests: boolean;
  canApproveFromUi: boolean;
  notes: string[];
}

export interface ProviderPermissionPendingApproval {
  requestId: string;
  title: string;
  details: string | null;
  source: string;
  canRespond: boolean;
  updatedAt: string;
}

export interface ProviderPermissionRuntimeState {
  profileId: string;
  sessionId: string | null;
  selectedModeId: string | null;
  effectiveModeId: string | null;
  effectiveModeLabel: string | null;
  approvalLabel: string | null;
  sandboxLabel: string | null;
  toolsLabel: string | null;
  trustLabel: string | null;
  updatedAt: string | null;
  pendingApproval: ProviderPermissionPendingApproval | null;
}

export interface ProviderPermissionCatalog {
  selectedModeId: string | null;
  availableModes: ProviderPermissionModeOption[];
  capabilities: ProviderPermissionCapabilities;
  runtime: ProviderPermissionRuntimeState | null;
}

interface PersistedPermissionSelections {
  profiles?: Record<string, {
    modeId?: string;
    updatedAt?: string;
  }>;
}

const PERMISSION_SELECTIONS_FILE = path.join(CODEX_APP_CONFIG.queueRoot, 'permission-selections.json');

let selectionLoadPromise: Promise<void> | null = null;
let selectionPersistTail: Promise<void> = Promise.resolve();
let selectionState: PersistedPermissionSelections = {
  profiles: {},
};

function nowIso(): string {
  return new Date().toISOString();
}

function buildSupportMode(profile: CodexProfile): ProviderPermissionModeOption {
  return {
    id: 'support-sandbox',
    label: 'מצב תמיכה',
    accessLevel: 'balanced',
    modeLabel: 'support-sandbox',
    summary: 'מצב תמיכה מבודד: כל הכתיבה מותרת רק לארגז החול הפנימי של code-ai.',
    description: 'קריאה חופשית בפרויקט, כתיבה רק בתוך Sandbox התמיכה.',
    approvalLabel: 'אישורים: מעטפת תמיכה קבועה',
    sandboxLabel: profile.sandboxCwd ? `Sandbox: ${profile.sandboxCwd}` : 'Sandbox: support workspace',
    toolsLabel: 'Files: קריאה חופשית, כתיבה רק ב־sandbox',
    trustLabel: profile.sourceProfileId ? `Source profile: ${profile.sourceProfileId}` : 'Source profile: isolated',
  };
}

function getStandardModes(provider: AppProvider): ProviderPermissionModeOption[] {
  if (provider === 'claude') {
    return [
      {
        id: 'restricted',
        label: 'תכנון בלבד',
        accessLevel: 'restricted',
        modeLabel: 'plan',
        summary: 'Claude נשאר במצב קריאה ותכנון בלבד.',
        description: 'ללא כתיבה וללא הרצת עריכות. מתאים לבדיקה בטוחה.',
        approvalLabel: 'אישורים: plan',
        sandboxLabel: 'Sandbox: ניהול פנימי של Claude',
        toolsLabel: 'Tools: קריאה/תכנון',
        trustLabel: 'Workspace: add-dir פעיל לקריאה',
      },
      {
        id: 'balanced',
        label: 'מאוזן',
        accessLevel: 'balanced',
        modeLabel: 'default',
        summary: 'Claude יכול להציע פעולות וכלי כתיבה, אך במצב שמבוסס על אישורים.',
        description: 'ברירת המחדל הבטוחה של Claude Code.',
        approvalLabel: 'אישורים: default',
        sandboxLabel: 'Sandbox: ללא דגל sandbox CLI',
        toolsLabel: 'Tools: דורשים החלטת permission mode',
        trustLabel: 'Workspace: add-dir פעיל לפי הצורך',
      },
      {
        id: 'full',
        label: 'גישה מלאה',
        accessLevel: 'full',
        modeLabel: 'bypassPermissions',
        summary: 'Claude רץ בלי בקשות אישור ידניות, עם גישת tools מלאה ל־workspace.',
        description: 'המצב החזק ביותר, תואם להתנהגות שהייתה עד עכשיו.',
        approvalLabel: 'אישורים: bypassPermissions',
        sandboxLabel: 'Sandbox: ללא sandbox CLI',
        toolsLabel: 'Tools: מלאים',
        trustLabel: 'Workspace: add-dir פעיל לפי הצורך',
      },
    ];
  }

  if (provider === 'gemini') {
    return [
      {
        id: 'restricted',
        label: 'תכנון בלבד',
        accessLevel: 'restricted',
        modeLabel: 'plan',
        summary: 'Gemini פועל במצב plan/read-only.',
        description: 'מתאים לניתוח, תכנון ובדיקת קבצים בלי לבצע שינויים.',
        approvalLabel: 'אישורים: plan',
        sandboxLabel: 'Sandbox: לפי מדיניות CLI',
        toolsLabel: 'Tools: קריאה/תכנון',
        trustLabel: 'Workspace: skip-trust',
      },
      {
        id: 'balanced',
        label: 'מאוזן',
        accessLevel: 'balanced',
        modeLabel: 'default',
        summary: 'Gemini רץ עם approval mode רגיל.',
        description: 'מאפשר פעולות כתיבה, בכפוף לזרימת אישורים של Gemini CLI.',
        approvalLabel: 'אישורים: default',
        sandboxLabel: 'Sandbox: לא הופעל דגל מפורש',
        toolsLabel: 'Tools: לפי approval-mode',
        trustLabel: 'Workspace: skip-trust',
      },
      {
        id: 'full',
        label: 'גישה מלאה',
        accessLevel: 'full',
        modeLabel: 'yolo',
        summary: 'Gemini רץ עם אישור אוטומטי לכל הפעולות ו־skip-trust פעיל.',
        description: 'המצב החזק ביותר, תואם להתנהגות שהייתה עד עכשיו.',
        approvalLabel: 'אישורים: yolo',
        sandboxLabel: 'Sandbox: לא הופעל דגל מפורש',
        toolsLabel: 'Tools: auto-approve',
        trustLabel: 'Workspace: skip-trust',
      },
    ];
  }

  return [
    {
      id: 'restricted',
      label: 'קריאה בלבד',
      accessLevel: 'restricted',
      modeLabel: 'read-only',
      summary: 'Codex רץ במצב read-only עם בקשות אישור.',
      description: 'מתאים לחקירה, סקירה וניתוח ללא כתיבה לדיסק.',
      approvalLabel: 'אישורים: on-request',
      sandboxLabel: 'Sandbox: read-only',
      toolsLabel: 'Shell: קריאה בלבד',
      trustLabel: 'Workspace: trusted',
    },
    {
      id: 'balanced',
      label: 'מאוזן',
      accessLevel: 'balanced',
      modeLabel: 'workspace-write',
      summary: 'Codex יכול לערוך בתוך ה־workspace, עם בקשות אישור.',
      description: 'מאפשר עבודה רגילה עם sandbox מוגבל ל־workspace.',
      approvalLabel: 'אישורים: on-request',
      sandboxLabel: 'Sandbox: workspace-write',
      toolsLabel: 'Shell: כתיבה בתוך ה־workspace',
      trustLabel: 'Workspace: trusted',
    },
    {
      id: 'full',
      label: 'גישה מלאה',
      accessLevel: 'full',
      modeLabel: 'danger-full-access',
      summary: 'Codex רץ בלי sandbox ובלי אישורי ביניים.',
      description: 'המצב החזק ביותר, תואם להתנהגות שהייתה עד עכשיו.',
      approvalLabel: 'אישורים: bypass / never',
      sandboxLabel: 'Sandbox: danger-full-access',
      toolsLabel: 'Shell: מלא',
      trustLabel: 'Workspace: trusted',
    },
  ];
}

export function getAvailablePermissionModes(profile: CodexProfile): ProviderPermissionModeOption[] {
  if (profile.mode === 'support') {
    return [buildSupportMode(profile)];
  }

  return getStandardModes(profile.provider);
}

export function getPermissionCapabilities(profile: CodexProfile): ProviderPermissionCapabilities {
  if (profile.mode === 'support') {
    return {
      canChangeMode: false,
      detectsLiveApprovalRequests: false,
      canApproveFromUi: false,
      notes: [
        'מצב תמיכה משתמש במעטפת קבועה כדי לבודד את כל הכתיבה לארגז החול של code-ai.',
      ],
    };
  }

  if (profile.provider === 'claude') {
    return {
      canChangeMode: true,
      detectsLiveApprovalRequests: true,
      canApproveFromUi: false,
      notes: [
        'מצב ההרשאה של Claude מזוהה בזמן אמת מתוך stream-json.',
        'אישור חי מתוך ה־UI דורש transport ייעודי של permission prompt tool, ולא הופעל עדיין ב־code-ai.',
      ],
    };
  }

  if (profile.provider === 'gemini') {
    return {
      canChangeMode: true,
      detectsLiveApprovalRequests: false,
      canApproveFromUi: false,
      notes: [
        'Gemini תומך ב־approval modes, אך בנתיב ה־headless הפעיל אין לנו עדיין event חיצוני אמין ל־approve/reject.',
      ],
    };
  }

  return {
    canChangeMode: true,
    detectsLiveApprovalRequests: false,
    canApproveFromUi: false,
    notes: [
      'Codex תומך בבחירת sandbox ואישור, אבל בנתיב exec --json הנוכחי לא מתקבל אצלנו approval prompt בר־תגובה מה־UI.',
    ],
  };
}

async function ensureSelectionStateLoaded() {
  if (!selectionLoadPromise) {
    selectionLoadPromise = (async () => {
      try {
        const raw = await fs.readFile(PERMISSION_SELECTIONS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        selectionState = parsed && typeof parsed === 'object'
          ? parsed as PersistedPermissionSelections
          : { profiles: {} };
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          throw error;
        }
        selectionState = { profiles: {} };
      }

      selectionState.profiles = selectionState.profiles || {};
    })();
  }

  await selectionLoadPromise;
}

async function persistSelectionState() {
  await ensureSelectionStateLoaded();
  const snapshot = JSON.stringify(selectionState, null, 2);
  selectionPersistTail = selectionPersistTail.then(async () => {
    await fs.mkdir(path.dirname(PERMISSION_SELECTIONS_FILE), { recursive: true });
    await fs.writeFile(PERMISSION_SELECTIONS_FILE, snapshot, 'utf-8');
  });
  await selectionPersistTail;
}

export function getDefaultPermissionModeId(profile: CodexProfile): string {
  if (profile.mode === 'support') {
    return 'support-sandbox';
  }
  return 'full';
}

export async function getSelectedPermissionModeId(profile: CodexProfile): Promise<string> {
  await ensureSelectionStateLoaded();
  const availableModes = getAvailablePermissionModes(profile);
  const configuredModeId = selectionState.profiles?.[profile.id]?.modeId;
  if (configuredModeId && availableModes.some((mode) => mode.id === configuredModeId)) {
    return configuredModeId;
  }
  return getDefaultPermissionModeId(profile);
}

export async function setSelectedPermissionModeId(
  profile: CodexProfile,
  modeId: string
): Promise<string> {
  await ensureSelectionStateLoaded();
  const availableModes = getAvailablePermissionModes(profile);
  if (!availableModes.some((mode) => mode.id === modeId)) {
    throw new Error('Permission mode is not valid for this profile');
  }

  selectionState.profiles = selectionState.profiles || {};
  selectionState.profiles[profile.id] = {
    modeId,
    updatedAt: nowIso(),
  };
  await persistSelectionState();
  return modeId;
}

export async function getSelectedPermissionMode(
  profile: CodexProfile
): Promise<ProviderPermissionModeOption> {
  return resolvePermissionMode(profile, await getSelectedPermissionModeId(profile));
}

export function resolvePermissionMode(
  profile: CodexProfile,
  modeId: string | null | undefined
): ProviderPermissionModeOption {
  const modes = getAvailablePermissionModes(profile);
  return modes.find((mode) => mode.id === modeId) || modes[0] || buildSupportMode(profile);
}

export function buildPermissionSnapshotFromMode(
  profile: CodexProfile,
  selectedMode: ProviderPermissionModeOption,
  runtime?: Partial<ProviderPermissionRuntimeState> | null
): CodexPermissionSnapshot {
  const capabilities = getPermissionCapabilities(profile);
  const runtimeState: ProviderPermissionRuntimeState = {
    profileId: profile.id,
    sessionId: runtime?.sessionId || null,
    selectedModeId: selectedMode.id,
    effectiveModeId: runtime?.effectiveModeId || selectedMode.id,
    effectiveModeLabel: runtime?.effectiveModeLabel || selectedMode.modeLabel,
    approvalLabel: runtime?.approvalLabel || selectedMode.approvalLabel,
    sandboxLabel: runtime?.sandboxLabel || selectedMode.sandboxLabel,
    toolsLabel: runtime?.toolsLabel || selectedMode.toolsLabel,
    trustLabel: runtime?.trustLabel || selectedMode.trustLabel,
    updatedAt: runtime?.updatedAt || null,
    pendingApproval: runtime?.pendingApproval || null,
  };

  return {
    accessLevel: selectedMode.accessLevel,
    accessLabel: selectedMode.label,
    modeLabel: runtimeState.effectiveModeLabel || selectedMode.modeLabel,
    summary: selectedMode.summary,
    approvalLabel: runtimeState.approvalLabel,
    sandboxLabel: runtimeState.sandboxLabel,
    toolsLabel: runtimeState.toolsLabel,
    trustLabel: runtimeState.trustLabel,
    selectedModeId: selectedMode.id,
    availableModes: getAvailablePermissionModes(profile),
    capabilities,
    runtime: runtimeState,
  };
}

export async function buildPermissionCatalog(
  profile: CodexProfile,
  runtime?: Partial<ProviderPermissionRuntimeState> | null
): Promise<ProviderPermissionCatalog> {
  const selectedMode = await getSelectedPermissionMode(profile);
  const snapshot = buildPermissionSnapshotFromMode(profile, selectedMode, runtime);
  return {
    selectedModeId: snapshot.selectedModeId || selectedMode.id,
    availableModes: snapshot.availableModes || [],
    capabilities: snapshot.capabilities || getPermissionCapabilities(profile),
    runtime: snapshot.runtime || null,
  };
}
