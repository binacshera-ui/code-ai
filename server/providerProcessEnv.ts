const SERVER_ONLY_ENVIRONMENT_KEYS = [
  // CODE-AI owns final-response delivery. Provider CLIs and commands launched
  // by them must never receive the phone notification endpoint or its state.
  'CODEX_NTFY_URL',
  'CODEX_NTFY_ACCESS_TOKEN',
  'CODEX_NTFY_ENABLED',
  'CODEX_NTFY_DEFAULT_ENABLED',
  'CODEX_NTFY_STATE_FILE',
] as const;

export function isolateProviderProcessEnv(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const isolated = { ...environment };

  for (const key of SERVER_ONLY_ENVIRONMENT_KEYS) {
    delete isolated[key];
  }

  return isolated;
}
