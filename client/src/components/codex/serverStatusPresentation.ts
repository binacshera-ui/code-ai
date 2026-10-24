import type { ServerStatusNetwork, ServerStatusSnapshot, ServerStatusVolume, StorageMedium } from '../../../../shared/serverStatus';

export const SERVER_STATUS_HISTORY_LIMIT = 60;
export const SERVER_STATUS_POLL_MS = 2_000;
export const SERVER_STATUS_TIMEOUT_MS = 15_000;

export function serverStatusWarningLabel(code: string): string {
  const direct: Record<string, string> = {
    cpu_warming_up: 'ניצול המעבד יופיע לאחר שתי דגימות.',
    network_warming_up: 'קצב הרשת יופיע לאחר שתי דגימות של מוני התעבורה.',
    network_partial: 'חלק מממשקי הרשת אינם זמינים למדידה.',
    storage_medium_unknown: 'לא ניתן לזהות את סוג החומרה של חלק מנפחי האחסון; הם מוצגים בקבוצת אחר.',
  };
  if (direct[code]) return direct[code];
  const match = /^(cpu|memory|storage|storage_metadata|network)_(pending|stale|unavailable)$/.exec(code);
  if (!match) return 'חלק מנתוני השרת אינם זמינים למדידה.';
  const subject: Record<string, string> = { cpu: 'נתוני המעבד', memory: 'נתוני הזיכרון', storage: 'נתוני האחסון', storage_metadata: 'פרטי חומרת האחסון', network: 'נתוני הרשת' };
  const state: Record<string, string> = { pending: 'ממתינים לדגימה.', stale: 'טרם התעדכנו; מוצגת הקריאה האחרונה הזמינה.', unavailable: 'אינם זמינים כרגע.' };
  return `${subject[match[1]]} ${state[match[2]]}`;
}

export function formatServerBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return 'לא זמין';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** exponent).toLocaleString('en-US', { maximumFractionDigits: exponent ? 1 : 0 })} ${units[exponent]}`;
}

export function formatServerPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'ממתין לדגימה' : `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
}

export function formatServerRate(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'ממתין לדגימה' : `${formatServerBytes(value)}/s`;
}

export function formatServerUptime(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 60) return `${minutes} דקות`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} שעות ו־${minutes % 60} דקות` : `${Math.floor(hours / 24)} ימים ו־${hours % 24} שעות`;
}

export function appendServerStatusHistory(history: ServerStatusSnapshot[], snapshot: ServerStatusSnapshot): ServerStatusSnapshot[] {
  const sampledAt = Date.parse(snapshot.sampledAt);
  if (!Number.isFinite(sampledAt)) return history;
  const previous = history.at(-1);
  if (previous && Date.parse(previous.sampledAt) >= sampledAt) return history;
  return [...history, snapshot].slice(-SERVER_STATUS_HISTORY_LIMIT);
}

export function primaryServerNetwork(network: ServerStatusNetwork[] | null | undefined): ServerStatusNetwork | null {
  return network?.find(item => item.isDefault) || network?.find(item => item.state === 'up') || network?.[0] || null;
}

export function groupServerVolumes(volumes: ServerStatusVolume[]) {
  return (['nvme', 'hdd', 'ssd', 'other'] as StorageMedium[]).map(medium => {
    const items = volumes.filter(volume => volume.medium === medium);
    return {
      medium,
      volumes: items,
      totalBytes: items.reduce((sum, volume) => sum + volume.totalBytes, 0),
      usedBytes: items.reduce((sum, volume) => sum + volume.usedBytes, 0),
      availableBytes: items.reduce((sum, volume) => sum + volume.availableBytes, 0),
      reservedBytes: items.reduce((sum, volume) => sum + volume.reservedBytes, 0),
    };
  });
}

export interface ServerTrendPoint { at: number; value: number | null }
/** Gaps and unknown samples remain gaps; a single real sample is a dot, never a fabricated line. */
export function serverTrendGeometry(points: ServerTrendPoint[], maximum?: number) {
  const chronological = points.filter((point, index) => Number.isFinite(point.at) && (index === 0 || point.at > points[index - 1].at));
  const values = chronological.flatMap(point => point.value != null && Number.isFinite(point.value) && point.value >= 0 ? [point.value] : []);
  const max = maximum || Math.max(1, ...values);
  const first = chronological[0]?.at || 0;
  const duration = Math.max(1, (chronological.at(-1)?.at || first) - first);
  const segments: Array<Array<{ x: number; y: number }>> = [];
  let segment: Array<{ x: number; y: number }> = [];
  chronological.forEach((point, index) => {
    const gap = index > 0 && point.at - chronological[index - 1].at > 8_000;
    if (gap || point.value == null || !Number.isFinite(point.value) || point.value < 0) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (point.value != null && Number.isFinite(point.value) && point.value >= 0) {
      segment.push({ x: 2 + ((point.at - first) / duration) * 316, y: 56 - Math.min(1, point.value / max) * 52 });
    }
  });
  if (segment.length) segments.push(segment);
  return {
    paths: segments.filter(items => items.length > 1).map(items => items.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')),
    dots: segments.filter(items => items.length === 1).map(items => items[0]),
    count: values.length,
  };
}

interface PollingVisibility {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}
interface PollingOptions {
  load: (signal: AbortSignal) => Promise<ServerStatusSnapshot>;
  visibility: PollingVisibility;
  onSnapshot: (snapshot: ServerStatusSnapshot) => void;
  onError: (error: Error) => void;
  onPending: (pending: boolean) => void;
  onVisibility?: (hidden: boolean) => void;
  intervalMs?: number;
  timeoutMs?: number;
}

/** One request at a time, including retries and visibility changes. No background polling. */
export function startServerStatusPolling(options: PollingOptions) {
  let stopped = false;
  let busy = false;
  let repeatRequested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  async function poll() {
    clearTimer();
    if (stopped || options.visibility.hidden) return;
    if (busy) { repeatRequested = true; return; }
    busy = true;
    repeatRequested = false;
    let timedOut = false;
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => { timedOut = true; request.abort(); }, options.timeoutMs ?? SERVER_STATUS_TIMEOUT_MS);
    options.onPending(true);
    try {
      const snapshot = await options.load(request.signal);
      if (!stopped && !request.signal.aborted && !options.visibility.hidden) options.onSnapshot(snapshot);
    } catch (error) {
      if (!stopped && !options.visibility.hidden && (timedOut || !request.signal.aborted)) {
        options.onError(timedOut ? new Error('השרת לא השיב בתוך 15 שניות.') : error instanceof Error ? error : new Error('קריאת מצב השרת נכשלה.'));
      }
    } finally {
      clearTimeout(timeout);
      busy = false;
      if (controller === request) controller = undefined;
      if (!stopped) {
        options.onPending(false);
        if (!options.visibility.hidden) timer = setTimeout(() => void poll(), repeatRequested ? 0 : options.intervalMs ?? SERVER_STATUS_POLL_MS);
      }
    }
  }
  const visibilityChanged = () => {
    options.onVisibility?.(options.visibility.hidden);
    clearTimer();
    if (options.visibility.hidden) controller?.abort();
    else void poll();
  };
  options.visibility.addEventListener('visibilitychange', visibilityChanged);
  options.onVisibility?.(options.visibility.hidden);
  void poll();
  return {
    refresh: () => void poll(),
    stop: () => { stopped = true; clearTimer(); controller?.abort(); options.visibility.removeEventListener('visibilitychange', visibilityChanged); },
  };
}
