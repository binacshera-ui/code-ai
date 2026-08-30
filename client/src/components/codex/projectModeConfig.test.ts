import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ProjectModeDialog,
  type CodexSessionProjectModeValue,
} from './ProjectModeDialog';
import {
  PROJECT_MODE_CONFIG_KIND,
  parseProjectModeConfigText,
  serializeProjectModeConfig,
} from './projectModeConfig';

function baseMode(): CodexSessionProjectModeValue {
  return {
    enabled: false,
    projectName: '',
    geminiProfileId: 'gemini-main',
    uiProtocol: 'http',
    uiPort: 0,
    uiUrl: '',
    frontendRoot: '/workspace',
    backendRoot: '/workspace',
    designSystemPath: '',
    productBrief: '',
    businessContext: '',
    primaryOutcome: '',
    targetAudience: '',
    userArchetypes: '',
    userResearchNotes: '',
    contentVoice: '',
    locales: 'he-IL',
    accessibilityRequirements: 'WCAG 2.2 AA',
    responsiveRequirements: 'mobile and desktop',
    analyticsRequirements: '',
    designSchool: '',
    desiredFeeling: '',
    fontFamily: '',
    palette: {
      primary: '#111827',
      secondary: '#4f46e5',
      accent: '#06b6d4',
      background: '#f8fafc',
      surface: '#ffffff',
      text: '#0f172a',
    },
    direction: 'rtl',
    platform: 'responsive-web',
    preserveExistingUi: true,
    simpleProfessionalMode: false,
    referenceUrls: [],
    constraints: [],
    successCriteria: [],
    programScale: 'enterprise',
    maxParallelAgents: 8,
    portReachable: true,
    portCheckedAt: '2026-08-28T12:00:00.000Z',
    artifactsRoot: '/private/runtime',
    createdAt: '2026-08-28T12:00:00.000Z',
    updatedAt: '2026-08-28T12:00:00.000Z',
  };
}

test('imports a versioned UTF-8 project configuration and preserves Hebrew and line breaks', () => {
  const source = `\uFEFF${JSON.stringify({
    kind: PROJECT_MODE_CONFIG_KIND,
    version: 1,
    projectMode: {
      projectName: 'מערכת ניהול',
      geminiProfileId: 'gemini-main',
      uiPort: 4177,
      productBrief: 'שורה ראשונה\nשורה שנייה בעברית',
      palette: { primary: '#ABCDEF' },
      maxParallelAgents: 6,
      constraints: ['אין למחוק API קיים', 'RTL מלא'],
    },
  })}`;

  const result = parseProjectModeConfigText(source, baseMode(), ['gemini-main']);

  assert.equal(result.value.enabled, true);
  assert.equal(result.value.projectName, 'מערכת ניהול');
  assert.equal(result.value.productBrief, 'שורה ראשונה\nשורה שנייה בעברית');
  assert.equal(result.value.palette.primary, '#abcdef');
  assert.equal(result.value.palette.secondary, '#4f46e5');
  assert.deepEqual(result.value.constraints, ['אין למחוק API קיים', 'RTL מלא']);
  assert.equal(result.value.portReachable, false);
  assert.equal(result.value.portCheckedAt, null);
  assert.equal(result.value.artifactsRoot, '/private/runtime');
});

test('accepts a plain project object while forcing activation', () => {
  const result = parseProjectModeConfigText(JSON.stringify({
    enabled: false,
    projectName: 'Plain import',
    uiPort: 3001,
  }), baseMode());

  assert.equal(result.value.enabled, true);
  assert.equal(result.value.projectName, 'Plain import');
  assert.equal(result.value.uiPort, 3001);
  assert.equal(result.warnings.length, 2);
});

test('rejects server-managed and unknown fields', () => {
  assert.throws(
    () => parseProjectModeConfigText(JSON.stringify({ artifactsRoot: '/tmp/escape' }), baseMode()),
    /מנוהל על ידי השרת/,
  );
  assert.throws(
    () => parseProjectModeConfigText(JSON.stringify({ mysterySetting: true }), baseMode()),
    /אינו מוכר/,
  );
});

test('rejects invalid enums, colors, ranges and unavailable Gemini profiles', () => {
  assert.throws(
    () => parseProjectModeConfigText(JSON.stringify({ direction: 'auto' }), baseMode()),
    /direction/,
  );
  assert.throws(
    () => parseProjectModeConfigText(JSON.stringify({ palette: { accent: 'cyan' } }), baseMode()),
    /hex מלא/,
  );
  assert.throws(
    () => parseProjectModeConfigText(JSON.stringify({ maxParallelAgents: 20 }), baseMode()),
    /בין 2 ל־8/,
  );
  assert.throws(
    () => parseProjectModeConfigText(JSON.stringify({ geminiProfileId: 'missing' }), baseMode(), ['gemini-main']),
    /אינו זמין/,
  );
});

test('exports the portable v1 contract without server runtime fields and supports round trip', () => {
  const original = {
    ...baseMode(),
    projectName: 'פרויקט לייצוא',
    productBrief: 'תוכן עברי\nבשתי שורות',
    uiPort: 4177,
  };
  const serialized = serializeProjectModeConfig(original);
  const parsedJson = JSON.parse(serialized);

  assert.equal(parsedJson.kind, PROJECT_MODE_CONFIG_KIND);
  assert.equal(parsedJson.version, 1);
  assert.equal(parsedJson.projectMode.artifactsRoot, undefined);
  assert.equal(parsedJson.projectMode.portReachable, undefined);
  assert.equal(parsedJson.projectMode.updatedAt, undefined);

  const imported = parseProjectModeConfigText(serialized, baseMode(), ['gemini-main']);
  assert.equal(imported.value.projectName, original.projectName);
  assert.equal(imported.value.productBrief, original.productBrief);
  assert.equal(imported.value.enabled, true);
});

test('renders the JSON import controls inside the scrollable Project Mode dialog', () => {
  const html = renderToStaticMarkup(createElement(ProjectModeDialog, {
    isOpen: true,
    provider: 'codex',
    value: baseMode(),
    profiles: [{ id: 'gemini-main', label: 'Gemini Main' }],
    isSaving: false,
    onClose: () => undefined,
    onChange: () => undefined,
    onImport: async () => ({ ok: true }),
    onSave: () => undefined,
    onDisable: () => undefined,
  }));

  assert.match(html, /הפעל באמצעות קובץ JSON/);
  assert.match(html, /בחר JSON והפעל/);
  assert.match(html, /הורד JSON נוכחי/);
  assert.match(html, /accept="application\/json,.json"/);
  assert.match(html, /overflow-y-auto/);
});
