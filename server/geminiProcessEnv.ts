const GEMINI_INHERITED_RUNTIME_KEYS = [
  // Gemini CLI treats any non-empty DEBUG value as a request to publish its
  // sandbox debugger. PM2 currently supplies DEBUG=release to CODE-AI, which
  // otherwise makes Docker claim the default Node inspector port (9229).
  'DEBUG',
  'DEBUG_PORT',
  // Runtime/debugger state belongs to the CODE-AI parent process and must not
  // leak into a separately spawned provider CLI.
  'NODE_OPTIONS',
  'NODE_CHANNEL_FD',
  'NODE_CHANNEL_SERIALIZATION_MODE',
  'NODE_INSPECT_RESUME_ON_START',
  'VSCODE_INSPECTOR_OPTIONS',
] as const;

/**
 * Builds a provider environment that preserves credentials and normal user
 * configuration while removing process-manager and debugger state inherited
 * from CODE-AI. The final layer wins before isolation is applied, so an
 * accidental DEBUG entry in either PM2 or a profile .env cannot re-enable the
 * Gemini sandbox debugger.
 */
export function buildIsolatedGeminiProcessEnv(
  ...layers: Array<NodeJS.ProcessEnv | Record<string, string> | null | undefined>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const layer of layers) {
    if (!layer) continue;
    Object.assign(env, layer);
  }

  for (const key of GEMINI_INHERITED_RUNTIME_KEYS) {
    delete env[key];
  }

  return env;
}
