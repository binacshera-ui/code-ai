import path from 'node:path';
import { validateDeploymentRequest } from '../coordinator.mjs';

const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

function fail(reason) { throw Object.assign(new Error('Deferred deployment unit configuration refused.'), { reason }); }

function checkedAbsolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\u0000]/.test(value)
    || path.normalize(value) !== value || value === '/') fail('unsafe_unit_path');
  return value;
}

function unitArgument(value) {
  // Percent is a systemd specifier even inside quotes, so it is doubled.
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
}

/**
 * Render only. Installation/enabling is deliberately a separate, authorized
 * rollout step after full artifact qualification and the first-install gate.
 * State/lock directories must already exist, owned 0700 by serviceUser.
 */
export function renderDeferredDeploymentUnits({ request, requestFile, stateFile, adapterFile, coordinatorFile,
  nodeExecutable, serviceUser, writablePaths = [] }) {
  validateDeploymentRequest(request);
  if (!SAFE_USER.test(serviceUser || '')) fail('explicit_service_user_required');
  for (const file of [requestFile, stateFile, adapterFile, coordinatorFile, nodeExecutable]) checkedAbsolute(file);
  const privateDirectory = path.dirname(stateFile);
  if (privateDirectory === '/' || [requestFile, adapterFile, coordinatorFile].includes(stateFile)) fail('unsafe_state_directory');
  if (!Array.isArray(writablePaths) || writablePaths.length > 20) fail('invalid_writable_paths');
  const writes = [...new Set([privateDirectory, ...writablePaths.map(checkedAbsolute)])];
  const name = `code-ai-deferred-deployment-${request.deploymentId.toLowerCase()}`;
  const lockFile = path.join(privateDirectory, 'coordinator.lock');
  const args = ['/usr/bin/flock', '--nonblock', '--close', '--conflict-exit-code=75', lockFile,
    nodeExecutable, coordinatorFile, '--request', requestFile, '--state', stateFile, '--adapter', adapterFile];
  const service = `[Unit]
Description=Qualified deferred Code AI deployment ${request.deploymentId}
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0
ConditionPathIsFile=${unitArgument(requestFile)}
ConditionPathIsFile=${unitArgument(adapterFile)}
ConditionPathIsFile=${unitArgument(coordinatorFile)}
RequiresMountsFor=${[privateDirectory, request.candidate.importRoot].map(unitArgument).join(' ')}

[Service]
Type=oneshot
User=${serviceUser}
UMask=0077
ExecStart=${args.map(unitArgument).join(' ')}
SuccessExitStatus=75
TimeoutStartSec=45s
TimeoutStopSec=3s
KillMode=control-group
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=${writes.map(unitArgument).join(' ')}
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=journal
StandardError=journal
`;
  const timer = `[Unit]
Description=Retry qualified deferred Code AI deployment ${request.deploymentId}

[Timer]
OnBootSec=30s
OnUnitInactiveSec=15s
AccuracySec=1s
RandomizedDelaySec=0
Unit=${name}.service

[Install]
WantedBy=timers.target
`;
  return { name, lockFile, stateDirectory: privateDirectory, service, timer };
}
