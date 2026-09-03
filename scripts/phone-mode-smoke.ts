import { probePhoneModeConnection } from '../server/codexPhoneMode.js';

function compact(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, any>;
  if (record.success === false) return { success: false, error: record.error || record.message || 'unknown' };
  const data = record.data && typeof record.data === 'object' ? record.data : record;
  return {
    success: record.success !== false,
    model: data.model || data.device?.model,
    androidVersion: data.androidVersion || data.systemVersion,
    percent: data.percent ?? data.powerState?.batteryLevel,
    temperatureC: data.temperatureC,
    connected: data.connected ?? data.bridge?.connected,
    currentApp: data.packageName || data.currentApp?.packageName,
    width: data.width,
    height: data.height,
    error: record.error,
  };
}

const status = await probePhoneModeConnection();
console.log(JSON.stringify(Object.fromEntries(Object.entries(status).map(([key, value]) => [key, compact(value)])), null, 2));
