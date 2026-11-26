export interface CodexLiveInputRecord {
  id: string;
  profileId: string;
  sessionId: string;
  clientRequestId: string;
  payloadHash: string;
  turnId: string;
  status: 'pending' | 'delivered' | 'not-delivered' | 'unconfirmed';
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface CodexLiveInputStore {
  get(profileId: string, requestId: string): CodexLiveInputRecord | null | Promise<CodexLiveInputRecord | null>;
  reserve(value: Pick<CodexLiveInputRecord, 'profileId' | 'sessionId' | 'clientRequestId' | 'payloadHash' | 'turnId'>): {created: boolean; row: CodexLiveInputRecord} | Promise<{created: boolean; row: CodexLiveInputRecord}>;
  markDelivered(id: string, turnId: string): CodexLiveInputRecord | Promise<CodexLiveInputRecord>;
  markNotDelivered(id: string, code?: string): CodexLiveInputRecord | Promise<CodexLiveInputRecord>;
  markUnconfirmed(id: string): CodexLiveInputRecord | Promise<CodexLiveInputRecord>;
  close(): void | Promise<void>;
}
export function createCodexLiveInputStore(options: {filename: string; now?: () => string}): Promise<CodexLiveInputStore>;
