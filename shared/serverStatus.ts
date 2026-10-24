/** Product-owned, read-only host telemetry contract. Bytes are bytes, rates bytes/s. */
export type StorageMedium = 'nvme' | 'hdd' | 'ssd' | 'other';
export interface ServerStatusVolume {
  device: string;
  mount: string;
  filesystem: string;
  medium: StorageMedium;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  reservedBytes: number;
  usedPercent: number;
}
export interface ServerStatusNetwork {
  name: string;
  isDefault: boolean;
  state: string;
  linkSpeedMbps: number | null;
  receivedBytes: number;
  transmittedBytes: number;
  receiveBytesPerSecond: number | null;
  transmitBytesPerSecond: number | null;
}
export interface ServerStatusSnapshot {
  version: 1;
  hostname: string;
  platform: string;
  sampledAt: string;
  sampleIntervalMs: number | null;
  uptimeSeconds: number;
  cpu: {
    model: string;
    logicalCores: number;
    usedPercent: number | null;
    freePercent: number | null;
    cores: Array<number | null>;
    loadAverage: number[];
  } | null;
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    freeBytes: number;
    cacheBytes: number;
    usedPercent: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  } | null;
  storage: { sampledAt: string; volumes: ServerStatusVolume[] } | null;
  network: ServerStatusNetwork[] | null;
  /** No command lines, credentials, user/session content or provider quota inference. */
  warnings: string[];
}
