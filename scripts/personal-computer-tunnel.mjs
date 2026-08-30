function requirePort(value, name) {
  const port = Number(String(value ?? '').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

export function readOptionalTunnelPort(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  return requirePort(value, name);
}

export function buildReverseForwardArgs({
  apiReversePort,
  sidecarPort,
  sshReversePort = null,
  sshLocalPort = 22,
}) {
  const normalizedApiReversePort = requirePort(apiReversePort, 'API reverse port');
  const normalizedSidecarPort = requirePort(sidecarPort, 'Sidecar port');
  const normalizedSshReversePort = readOptionalTunnelPort(
    sshReversePort,
    'SSH reverse port'
  );

  const mappings = [
    `127.0.0.1:${normalizedApiReversePort}:127.0.0.1:${normalizedSidecarPort}`,
  ];

  if (normalizedSshReversePort !== null) {
    if (normalizedSshReversePort === normalizedApiReversePort) {
      throw new Error('SSH and API reverse ports must be different');
    }
    const normalizedSshLocalPort = requirePort(sshLocalPort, 'Local SSH port');
    mappings.push(
      `127.0.0.1:${normalizedSshReversePort}:127.0.0.1:${normalizedSshLocalPort}`
    );
  }

  return mappings.flatMap((mapping) => ['-R', mapping]);
}
