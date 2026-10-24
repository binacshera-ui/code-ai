import { normalizeProfileIdentity, type ChromeProfileIdentity } from '../../../../chrome-extension/profileIdentity.js';
import type { PersonalChromeDeviceValue } from './PersonalChromeModeDialog';

export class ChromeProfileConflictError extends Error {
  readonly device: PersonalChromeDeviceValue;
  constructor(device: PersonalChromeDeviceValue) {
    super('הפרופיל השתנה במקום אחר. העריכה שלך נשמרה כאן; בדוק ושמור שוב.');
    this.device = device;
  }
}

/** A delayed list response must not undo a more recent acknowledged edit. */
export function mergeChromeProfiles(current: PersonalChromeDeviceValue[], incoming: PersonalChromeDeviceValue[]): PersonalChromeDeviceValue[] {
  return incoming.map(device => {
    const saved = current.find(entry => entry.id === device.id);
    if (!saved || (saved.profileRevision || 0) <= (device.profileRevision || 0)) return device;
    return { ...device, name: saved.name, profileIdentity: saved.profileIdentity, profileRevision: saved.profileRevision };
  });
}

export async function saveChromeProfile(
  deviceId: string, identity: ChromeProfileIdentity, baseRevision: number,
  request: (url: string, init: RequestInit) => Promise<Response>,
): Promise<PersonalChromeDeviceValue> {
  const profileIdentity = normalizeProfileIdentity(identity);
  if (!profileIdentity.name) throw new Error('יש להזין שם לפרופיל.');
  const response = await request(`/api/codex/browser-extension/devices/${encodeURIComponent(deviceId)}/profile`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileIdentity, baseRevision }),
  });
  const payload = (response.headers.get('content-type') || '').includes('application/json')
    ? await response.json().catch(() => ({})) : {};
  if (response.status === 409 && payload.device?.id === deviceId) throw new ChromeProfileConflictError(payload.device);
  if (response.status === 404) throw new Error('גרסת השרת הפעילה עדיין אינה תומכת בעריכת פרופילים. הפרטים שערכת נשארו כאן.');
  if (!response.ok || payload.saved !== true || payload.device?.id !== deviceId) {
    throw new Error('שמירת הפרופיל בשרת נכשלה. הפרטים שערכת נשארו כאן; אפשר לנסות שוב.');
  }
  return { ...payload.device, profileIdentity: normalizeProfileIdentity(payload.device.profileIdentity) };
}

export async function chromeProfilePicture(file: File): Promise<string> {
  if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 5_000_000) {
    throw new Error('בחר תמונת PNG, JPEG או WebP עד 5 MB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('לא ניתן להכין את תמונת הפרופיל.');
    context.drawImage(bitmap,0,0,96,96);
    const picture = canvas.toDataURL('image/png');
    const normalized = normalizeProfileIdentity({ avatarDataUrl: picture });
    if (!normalized.avatarDataUrl) throw new Error('לא ניתן לשמור את תמונת הפרופיל. נסה תמונה אחרת.');
    return normalized.avatarDataUrl;
  } finally { bitmap.close(); }
}
