import type { ChromeProfileIdentity } from './profileIdentity.js';
export interface ChromeProfileSnapshot { profileIdentity: ChromeProfileIdentity; profileRevision: number; }
export function profileRevision(value: unknown): number;
export function sameProfile(left: unknown, right: unknown): boolean;
export function profileSnapshot(identity: unknown, revision?: unknown): ChromeProfileSnapshot;
export function updateProfile(current: ChromeProfileSnapshot, input: {baseRevision: number; profileIdentity: unknown}): ChromeProfileSnapshot;
export function adoptInitialProfile(current: ChromeProfileSnapshot, incoming: unknown): ChromeProfileSnapshot;
export function receiveProfile(current: ChromeProfileSnapshot & {pendingIdentity?: ChromeProfileIdentity | null; conflict?: boolean}, incoming: ChromeProfileSnapshot): ChromeProfileSnapshot & {pendingIdentity: ChromeProfileIdentity | null; conflict: boolean};
