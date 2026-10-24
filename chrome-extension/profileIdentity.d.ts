export interface ChromeProfileIdentity {
  name: string;
  avatarDataUrl: string | null;
  source: 'custom' | 'chrome-local';
}
export function normalizeProfileIdentity(value: unknown): ChromeProfileIdentity;
