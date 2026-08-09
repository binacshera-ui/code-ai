module.exports = {
  apps: [
    {
      name: process.env.PM2_APP_NAME || 'code-ai-app',
      script: 'dist/server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      // code-ai is the central development workspace and legitimately handles
      // several concurrent agents plus very large session histories. Keep a
      // generous host-safety ceiling instead of the former 2G tripwire, which
      // was low enough to interrupt normal work.
      max_memory_restart: '12G',
      // Give the HTTP server and durable queue writer time to drain before
      // PM2 escalates a memory restart from SIGINT to SIGKILL.
      kill_timeout: 15_000,
      interpreter: 'node',
      // Allow V8 to use a large heap when required. PM2's 12G RSS ceiling still
      // protects the rest of the host from a runaway parent process.
      interpreter_args: '--env-file=.env --max-old-space-size=8192',
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        PORT: process.env.PORT || 4000,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
