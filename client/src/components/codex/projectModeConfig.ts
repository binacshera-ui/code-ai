import type { CodexSessionProjectModeValue } from './ProjectModeDialog';

export const PROJECT_MODE_CONFIG_KIND = 'code-ai.project-mode';
export const PROJECT_MODE_CONFIG_VERSION = 1;
export const PROJECT_MODE_CONFIG_MAX_BYTES = 256 * 1024;

export interface ProjectModeConfigImportResult {
  value: CodexSessionProjectModeValue;
  warnings: string[];
}

export class ProjectModeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectModeConfigError';
  }
}

const CONFIG_FIELDS = new Set([
  'enabled',
  'projectName',
  'geminiProfileId',
  'uiProtocol',
  'uiPort',
  'frontendRoot',
  'backendRoot',
  'designSystemPath',
  'productBrief',
  'businessContext',
  'primaryOutcome',
  'targetAudience',
  'userArchetypes',
  'userResearchNotes',
  'contentVoice',
  'locales',
  'accessibilityRequirements',
  'responsiveRequirements',
  'analyticsRequirements',
  'designSchool',
  'desiredFeeling',
  'fontFamily',
  'palette',
  'direction',
  'platform',
  'preserveExistingUi',
  'simpleProfessionalMode',
  'referenceUrls',
  'constraints',
  'successCriteria',
  'programScale',
  'maxParallelAgents',
]);

const SERVER_MANAGED_FIELDS = new Set([
  'uiUrl',
  'portReachable',
  'portCheckedAt',
  'artifactsRoot',
  'createdAt',
  'updatedAt',
]);

const STRING_LIMITS: Record<string, number> = {
  projectName: 240,
  geminiProfileId: 240,
  frontendRoot: 4_000,
  backendRoot: 4_000,
  designSystemPath: 4_000,
  productBrief: 40_000,
  businessContext: 40_000,
  primaryOutcome: 40_000,
  targetAudience: 40_000,
  userArchetypes: 40_000,
  userResearchNotes: 40_000,
  contentVoice: 8_000,
  locales: 2_000,
  accessibilityRequirements: 8_000,
  responsiveRequirements: 8_000,
  analyticsRequirements: 8_000,
  designSchool: 8_000,
  desiredFeeling: 8_000,
  fontFamily: 500,
};

const PALETTE_FIELDS = ['primary', 'secondary', 'accent', 'background', 'surface', 'text'] as const;
const LIST_FIELDS = ['referenceUrls', 'constraints', 'successCriteria'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function describeField(field: string): string {
  return `projectMode.${field}`;
}

function assertOnlyKnownFields(value: Record<string, unknown>): void {
  for (const field of Object.keys(value)) {
    if (SERVER_MANAGED_FIELDS.has(field)) {
      throw new ProjectModeConfigError(`השדה ${describeField(field)} מנוהל על ידי השרת ואסור להגדיר אותו בקובץ.`);
    }
    if (!CONFIG_FIELDS.has(field)) {
      throw new ProjectModeConfigError(`השדה ${describeField(field)} אינו מוכר בחוזה Project Mode v${PROJECT_MODE_CONFIG_VERSION}.`);
    }
  }
}

function readString(value: unknown, field: string, limit: number): string {
  if (typeof value !== 'string') {
    throw new ProjectModeConfigError(`השדה ${describeField(field)} חייב להיות מחרוזת.`);
  }
  const normalized = value.replace(/\r\n?/g, '\n');
  if (normalized.length > limit) {
    throw new ProjectModeConfigError(`השדה ${describeField(field)} ארוך מדי (${normalized.length} תווים; המקסימום הוא ${limit}).`);
  }
  return normalized;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ProjectModeConfigError(`השדה ${describeField(field)} חייב להיות true או false.`);
  }
  return value;
}

function readEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ProjectModeConfigError(`השדה ${describeField(field)} חייב להיות אחד מהערכים: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function readList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new ProjectModeConfigError(`השדה ${describeField(field)} חייב להיות מערך של מחרוזות.`);
  }
  if (value.length > 100) {
    throw new ProjectModeConfigError(`השדה ${describeField(field)} יכול להכיל עד 100 פריטים.`);
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      throw new ProjectModeConfigError(`הפריט ${index + 1} בשדה ${describeField(field)} חייב להיות מחרוזת.`);
    }
    const normalized = item.replace(/\r\n?/g, '\n').trim();
    if (normalized.length > 2_000) {
      throw new ProjectModeConfigError(`הפריט ${index + 1} בשדה ${describeField(field)} ארוך מ־2000 תווים.`);
    }
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function readPayload(parsed: Record<string, unknown>): { payload: Record<string, unknown>; warnings: string[] } {
  const isEnvelope = 'projectMode' in parsed || 'kind' in parsed || 'version' in parsed;
  if (!isEnvelope) {
    return {
      payload: parsed,
      warnings: ['הקובץ נטען כ־JSON פשוט. מומלץ לייצא אותו מחדש בפורמט Project Mode v1.'],
    };
  }

  const allowedEnvelopeFields = new Set(['kind', 'version', 'projectMode']);
  const unknownEnvelopeField = Object.keys(parsed).find((field) => !allowedEnvelopeFields.has(field));
  if (unknownEnvelopeField) {
    throw new ProjectModeConfigError(`השדה העליון ${unknownEnvelopeField} אינו מוכר בחוזה Project Mode.`);
  }
  if (parsed.kind !== PROJECT_MODE_CONFIG_KIND) {
    throw new ProjectModeConfigError(`kind חייב להיות "${PROJECT_MODE_CONFIG_KIND}".`);
  }
  if (parsed.version !== PROJECT_MODE_CONFIG_VERSION) {
    throw new ProjectModeConfigError(`גרסת הקובץ אינה נתמכת. הגרסה הנתמכת היא ${PROJECT_MODE_CONFIG_VERSION}.`);
  }
  if (!isRecord(parsed.projectMode)) {
    throw new ProjectModeConfigError('השדה projectMode חייב להיות אובייקט JSON.');
  }
  return { payload: parsed.projectMode, warnings: [] };
}

export function parseProjectModeConfigText(
  source: string,
  currentValue: CodexSessionProjectModeValue,
  availableGeminiProfileIds: readonly string[] = [],
): ProjectModeConfigImportResult {
  const utf8Source = source.replace(/^\uFEFF/, '');
  if (!utf8Source.trim()) throw new ProjectModeConfigError('קובץ ה־JSON ריק.');
  if (new TextEncoder().encode(utf8Source).byteLength > PROJECT_MODE_CONFIG_MAX_BYTES) {
    throw new ProjectModeConfigError('קובץ ה־JSON גדול מ־256KB.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Source);
  } catch (error: any) {
    throw new ProjectModeConfigError(`קובץ JSON אינו תקין: ${error?.message || 'שגיאת תחביר'}.`);
  }
  if (!isRecord(parsed)) throw new ProjectModeConfigError('שורש קובץ ה־JSON חייב להיות אובייקט.');

  const { payload, warnings } = readPayload(parsed);
  assertOnlyKnownFields(payload);

  const next: CodexSessionProjectModeValue = {
    ...currentValue,
    enabled: true,
    palette: { ...currentValue.palette },
    referenceUrls: [...currentValue.referenceUrls],
    constraints: [...currentValue.constraints],
    successCriteria: [...currentValue.successCriteria],
    uiUrl: '',
    portReachable: false,
    portCheckedAt: null,
  };

  for (const [field, limit] of Object.entries(STRING_LIMITS)) {
    if (!(field in payload)) continue;
    (next as unknown as Record<string, unknown>)[field] = readString(payload[field], field, limit);
  }

  if ('geminiProfileId' in payload && availableGeminiProfileIds.length > 0) {
    const requestedProfileId = String(next.geminiProfileId).trim();
    if (!availableGeminiProfileIds.includes(requestedProfileId)) {
      throw new ProjectModeConfigError(`פרופיל Gemini בשם "${requestedProfileId}" אינו זמין בחשבון הנוכחי.`);
    }
    next.geminiProfileId = requestedProfileId;
  }
  if ('uiProtocol' in payload) next.uiProtocol = readEnum(payload.uiProtocol, 'uiProtocol', ['http', 'https'] as const);
  if ('uiPort' in payload) {
    if (!Number.isInteger(payload.uiPort) || Number(payload.uiPort) < 1 || Number(payload.uiPort) > 65_535) {
      throw new ProjectModeConfigError(`השדה ${describeField('uiPort')} חייב להיות מספר שלם בין 1 ל־65535.`);
    }
    next.uiPort = Number(payload.uiPort);
  }
  if ('direction' in payload) next.direction = readEnum(payload.direction, 'direction', ['rtl', 'ltr', 'mixed'] as const);
  if ('platform' in payload) {
    next.platform = readEnum(payload.platform, 'platform', ['responsive-web', 'desktop-web', 'mobile-web', 'native-like-web', 'multi-surface'] as const);
  }
  if ('programScale' in payload) next.programScale = readEnum(payload.programScale, 'programScale', ['focused', 'full', 'enterprise'] as const);
  if ('preserveExistingUi' in payload) next.preserveExistingUi = readBoolean(payload.preserveExistingUi, 'preserveExistingUi');
  if ('simpleProfessionalMode' in payload) next.simpleProfessionalMode = readBoolean(payload.simpleProfessionalMode, 'simpleProfessionalMode');
  if ('maxParallelAgents' in payload) {
    if (!Number.isInteger(payload.maxParallelAgents) || Number(payload.maxParallelAgents) < 2 || Number(payload.maxParallelAgents) > 8) {
      throw new ProjectModeConfigError(`השדה ${describeField('maxParallelAgents')} חייב להיות מספר שלם בין 2 ל־8.`);
    }
    next.maxParallelAgents = Number(payload.maxParallelAgents);
  }

  for (const field of LIST_FIELDS) {
    if (field in payload) next[field] = readList(payload[field], field);
  }

  if ('palette' in payload) {
    if (!isRecord(payload.palette)) throw new ProjectModeConfigError(`השדה ${describeField('palette')} חייב להיות אובייקט.`);
    const unknownColor = Object.keys(payload.palette).find((field) => !PALETTE_FIELDS.includes(field as typeof PALETTE_FIELDS[number]));
    if (unknownColor) throw new ProjectModeConfigError(`צבע ${describeField(`palette.${unknownColor}`)} אינו מוכר.`);
    for (const colorField of PALETTE_FIELDS) {
      if (!(colorField in payload.palette)) continue;
      const color = payload.palette[colorField];
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color.trim())) {
        throw new ProjectModeConfigError(`הצבע ${describeField(`palette.${colorField}`)} חייב להיות hex מלא, לדוגמה #112233.`);
      }
      next.palette[colorField] = color.trim().toLowerCase();
    }
  }

  if ('enabled' in payload) {
    readBoolean(payload.enabled, 'enabled');
    if (payload.enabled === false) warnings.push('הערך enabled=false הוחלף ל־true, מפני שייבוא קובץ מפעיל את מצב הפרויקט.');
  }

  return { value: next, warnings };
}

export function serializeProjectModeConfig(value: CodexSessionProjectModeValue): string {
  const projectMode: Record<string, unknown> = {};
  for (const field of CONFIG_FIELDS) {
    if (field === 'enabled') continue;
    const fieldValue = (value as unknown as Record<string, unknown>)[field];
    projectMode[field] = Array.isArray(fieldValue)
      ? [...fieldValue]
      : isRecord(fieldValue)
        ? { ...fieldValue }
        : fieldValue;
  }
  return `${JSON.stringify({
    kind: PROJECT_MODE_CONFIG_KIND,
    version: PROJECT_MODE_CONFIG_VERSION,
    projectMode,
  }, null, 2)}\n`;
}
