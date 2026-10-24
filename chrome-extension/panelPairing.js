export function normalizePairingCode(value) {
  const code = String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(code)) {
    throw new Error('יש להזין את קוד החיבור בן שמונת התווים שנוצר ב־CODE-AI.');
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export async function pairPanelInstallation(input, sendMessage) {
  const origin = new URL(input.controlOrigin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
    throw new Error('כתובת CODE-AI אינה תקינה.');
  }
  const response = await sendMessage({
    type: 'PAIR_DEVICE',
    controlOrigin: origin.origin,
    code: normalizePairingCode(input.code),
    deviceName: String(input.deviceName || 'Chrome במחשב האישי').trim().slice(0, 120),
  });
  if (!response?.ok || !response.settings?.deviceId) {
    throw new Error(response?.error || 'צימוד התוסף לא הושלם.');
  }
  return response;
}
