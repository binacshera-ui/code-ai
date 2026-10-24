// Exact Chrome-local identity requires an explicit local import/native helper.
// Do not substitute a Google email, guessed name or generated avatar for it.
export function normalizeProfileIdentity(value) {
  const name = typeof value?.name === 'string'
    ? value.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) : '';
  const candidate = typeof value?.avatarDataUrl === 'string' ? value.avatarDataUrl : '';
  const avatarDataUrl = candidate.length <= 70_000
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(candidate)
    ? candidate : null;
  return { name, avatarDataUrl,
    source: value?.source === 'chrome-local' ? 'chrome-local' : 'custom' };
}
