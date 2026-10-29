export type CodexAccountAction = 'login' | 'logout' | 'read' | 'api-key';
export function getSharedAccountCommand(profile: { id: string; codexHome: string }, action: CodexAccountAction,
  fallbackBin: string, appRoot?: string): { bin: string; args: string[] };
export function runSharedAccountCommand(codexHome: string, action: CodexAccountAction, options?: {
  signal?: AbortSignal;
  apiKey?: string;
  onPrompt?: (prompt: { verificationUrl: string; userCode: string }) => void;
}): Promise<{ type: 'apiKey' | 'chatgpt' | null } | void>;
