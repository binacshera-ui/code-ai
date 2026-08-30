const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

function readServiceEnvironment() {
  const environment = {};
  for (const filename of ['.env', '.env.paths']) {
    const envPath = path.join(__dirname, filename);
    if (fs.existsSync(envPath)) {
      Object.assign(environment, parseEnv(fs.readFileSync(envPath, 'utf8')));
    }
  }
  return environment;
}

function readServicePort(value) {
  const port = Number(value || 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT in ${path.join(__dirname, '.env')}: ${value}`);
  }
  return String(port);
}

const serviceEnvironment = readServiceEnvironment();
const serviceName = serviceEnvironment.PM2_APP_NAME?.trim() || 'code-ai-app';
const servicePort = readServicePort(serviceEnvironment.PORT);

module.exports = {
  apps: [
    {
      name: serviceName,
      script: 'scripts/code-ai-pm2-entrypoint.mjs',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // A listen/configuration failure exits with EX_CONFIG (78). Restarting
      // cannot repair a bad port and previously produced an unbounded loop.
      stop_exit_codes: [78],
      watch: false,
      // code-ai is the central development workspace and legitimately handles
      // several concurrent agents plus very large session histories. Restart
      // before V8 reaches its 8G heap ceiling; a 12G PM2 limit could never
      // protect the process from a JavaScript heap OOM.
      max_memory_restart: '6G',
      // Give the HTTP server and durable queue writer time to drain before
      // PM2 escalates a memory restart from SIGINT to SIGKILL.
      kill_timeout: 15_000,
      interpreter: 'node',
      // Allow V8 to use a large heap when required. PM2's 6G RSS ceiling still
      // protects the rest of the host from a runaway parent process.
      interpreter_args: '--env-file=.env --max-old-space-size=8192',
      env: {
        NODE_ENV: serviceEnvironment.NODE_ENV?.trim() || 'production',
        PORT: servicePort,
        CODEX_APP_ROOT: serviceEnvironment.CODEX_APP_ROOT?.trim() || __dirname,
        CODEX_STORAGE_ROOT: serviceEnvironment.CODEX_STORAGE_ROOT?.trim()
          || path.join(__dirname, '.code-ai'),
        CODEX_WORKSPACE_ROOT: serviceEnvironment.CODEX_WORKSPACE_ROOT?.trim()
          || path.resolve(__dirname, '..'),
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
