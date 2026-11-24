export type CodexSpeedId = 'flex' | 'fast' | 'ultrafast';

export function normalizeCodexServiceTierValue(value: string | null | undefined): CodexSpeedId | null {
  const id = value?.trim().toLowerCase();
  if (id === 'standard' || id === 'default') return 'flex';
  if (id === 'priority') return 'fast';
  return id === 'flex' || id === 'fast' || id === 'ultrafast' ? id : null;
}

export function normalizeCodexServiceTierConfigValue(value: string | null | undefined): 'fast' | 'ultrafast' | null {
  const id = normalizeCodexServiceTierValue(value);
  return id === 'fast' || id === 'ultrafast' ? id : null;
}

const modes = [
  { id: 'flex', label: 'רגיל', description: 'מהירות רגילה ושימוש מאוזן במכסה.' },
  { id: 'fast', label: 'מהיר', description: 'מהירות תגובה גבוהה יותר עם שימוש מוגבר.' },
  { id: 'ultrafast', label: 'אולטרה פאסט', description: 'המהירות הגבוהה ביותר, עם צריכה מוגברת של מכסת המנוי.' },
] as const;

export function codexResponseSpeedModes(availableIds: readonly string[]) {
  return modes.filter(mode => mode.id === 'flex' || availableIds.includes(mode.id)).map(mode => ({ ...mode }));
}

export function selectedCodexResponseSpeed(availableIds: readonly string[], configured: string | null | undefined): CodexSpeedId {
  const selected = normalizeCodexServiceTierValue(configured);
  return selected && (selected === 'flex' || availableIds.includes(selected)) ? selected : 'flex';
}
