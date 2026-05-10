import express from 'express';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'path';
import { fileURLToPath } from 'url';
import dashboardRoutes from './dashboardRoutes.js';
import codexRoutes from './codexRoutes.js';
import { recordCodexServerCrash } from './codexCrashLogs.js';
import { CODEX_APP_CONFIG } from './config.js';
import { startCodexQueueWorker } from './codexQueue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 4000;
const configuredCorsOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception in code-ai:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled rejection in code-ai:', reason);
});

process.on('uncaughtExceptionMonitor', (error, origin) => {
  void recordCodexServerCrash({
    type: 'uncaughtException',
    origin,
    message: error.message,
    stack: error.stack || null,
  }).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  void recordCodexServerCrash({
    type: 'unhandledRejection',
    message: error.message,
    stack: error.stack || null,
  }).catch(() => {});
});

app.use(cors({
  origin(origin, callback) {
    if (!origin) {
      callback(null, true);
      return;
    }

    if (configuredCorsOrigins.length === 0 || configuredCorsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('CORS origin not allowed'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '25mb' }));
app.set('trust proxy', true);

const isProduction = process.env.NODE_ENV === 'production';
const PostgreSQLStore = connectPgSimple(session);
const sessionConfig: session.SessionOptions = {
  secret: CODEX_APP_CONFIG.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: isProduction,
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    sameSite: isProduction ? 'none' : 'lax',
    domain: isProduction && CODEX_APP_CONFIG.sessionCookieDomain
      ? CODEX_APP_CONFIG.sessionCookieDomain
      : undefined,
  },
  name: 'forum.session',
};

if (CODEX_APP_CONFIG.databaseUrl) {
  const sessionStore = new PostgreSQLStore({
    conString: CODEX_APP_CONFIG.databaseUrl,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  });

  sessionStore.on('connect', () => {
    console.log('✅ Session store connected to database');
  });

  sessionStore.on('disconnect', () => {
    console.log('❌ Session store disconnected from database');
  });

  sessionConfig.store = sessionStore;
} else {
  console.log('ℹ️ DATABASE_URL is not set, using in-memory session store');
}

app.use(
  session(sessionConfig)
);

// API endpoint to check shared session with main site
app.get('/api/auth/check-session', async (req, res) => {
  try {
    // Check if user is logged in via shared session
    const session = req.session as any;
    
    if (session?.customerId) {
      // Customer from main site is logged in
      res.json({
        authenticated: true,
        source: 'main_site',
        user: {
          id: session.customerId,
          email: session.customerEmail,
          name: session.customerEmail?.split('@')[0] || 'משתמש',
          authMethod: session.customerAuthMethod,
        }
      });
    } else if (session?.userId) {
      // Forum user from main site is logged in
      res.json({
        authenticated: true,
        source: 'forum',
        user: {
          id: session.userId,
          email: session.user?.email,
          name: session.user?.displayName || session.user?.username,
        }
      });
    } else {
      res.json({ authenticated: false });
    }
  } catch (error) {
    console.error('Session check error:', error);
    res.json({ authenticated: false, error: 'Session check failed' });
  }
});

app.use('/api/dashboard', dashboardRoutes);
app.use('/api/codex', codexRoutes);

const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Bina App server running on port ${PORT}`);
});

void startCodexQueueWorker()
  .then(() => {
    console.log('🤖 Codex queue worker started');
  })
  .catch((error) => {
    console.error('❌ Failed to start Codex queue worker:', error);
  });
