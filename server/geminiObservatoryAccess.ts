import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CODEX_APP_CONFIG } from './config.js';
import { readAuthenticatedUser } from './codexRoutes.js';

const GEMINI_OBSERVATORY_PASSWORD = process.env.GEMINI_OBSERVATORY_PASSWORD || '400305Ashim@';
const GEMINI_OBSERVATORY_COOKIE = 'gemini_observatory_unlock';

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeNextPath(value: unknown) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate.startsWith('/')) {
    return '/gemini-observatory';
  }

  if (candidate.startsWith('//') || candidate.includes('://')) {
    return '/gemini-observatory';
  }

  return candidate;
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie || '';
  return header.split(';').reduce<Record<string, string>>((accumulator, part) => {
    const [rawKey, ...rawValue] = part.split('=');
    const key = rawKey?.trim();
    if (!key) {
      return accumulator;
    }

    accumulator[key] = decodeURIComponent(rawValue.join('=').trim());
    return accumulator;
  }, {});
}

function readRequestHost(req: Request): string {
  const forwardedHost = req.headers['x-forwarded-host'];
  const rawHost = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost || req.headers.host || '';

  return rawHost.split(',')[0]?.trim().toLowerCase() || '';
}

function stripPort(host: string): string {
  return host.replace(/:\d+$/, '');
}

function createGeminiObservatoryUnlockToken(req: Request) {
  const host = stripPort(readRequestHost(req)) || 'gemini-observatory';
  return createHmac('sha256', CODEX_APP_CONFIG.sessionSecret)
    .update(`${host}|gemini-observatory-unlock`)
    .digest('hex');
}

function hasGeminiObservatoryUnlockCookie(req: Request) {
  const cookies = parseCookies(req);
  const current = cookies[GEMINI_OBSERVATORY_COOKIE];
  if (!current) {
    return false;
  }

  const expected = createGeminiObservatoryUnlockToken(req);
  try {
    return timingSafeEqual(Buffer.from(current), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function hasGeminiObservatoryAccess(req: Request) {
  const authState = readAuthenticatedUser(req);
  if (authState.authenticated && authState.deviceUnlocked) {
    return true;
  }

  return hasGeminiObservatoryUnlockCookie(req);
}

function renderLoginPage(nextPath: string, invalidPassword = false) {
  const nextValue = escapeHtml(nextPath);
  const errorHtml = invalidPassword
    ? '<p style="margin:0 0 16px;color:#b91c1c;font-size:14px;">הסיסמה שגויה.</p>'
    : '';

  return `<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gemini Observatory Access</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Noto Sans Hebrew", "Segoe UI", sans-serif;
        background: #f4f7fb;
        color: #0f172a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top right, rgba(14, 165, 233, 0.18), transparent 28%),
          linear-gradient(180deg, #f8fbff 0%, #eef4fb 100%);
      }
      .panel {
        width: min(420px, calc(100vw - 32px));
        border-radius: 28px;
        padding: 28px;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(148, 163, 184, 0.24);
        box-shadow: 0 24px 70px rgba(15, 23, 42, 0.16);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
        line-height: 1.1;
      }
      p {
        margin: 0 0 20px;
        color: #475569;
        line-height: 1.5;
      }
      label {
        display: block;
        margin-bottom: 8px;
        font-size: 14px;
        font-weight: 600;
        color: #0f172a;
      }
      input {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 16px;
        padding: 14px 16px;
        font-size: 16px;
        outline: none;
        background: #fff;
      }
      input:focus {
        border-color: #0891b2;
        box-shadow: 0 0 0 4px rgba(6, 182, 212, 0.12);
      }
      button {
        width: 100%;
        margin-top: 16px;
        border: 0;
        border-radius: 16px;
        padding: 14px 16px;
        background: linear-gradient(135deg, #0f766e, #0891b2);
        color: #fff;
        font-size: 16px;
        font-weight: 700;
        cursor: pointer;
      }
      .hint {
        margin-top: 14px;
        font-size: 12px;
        color: #64748b;
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <h1>Gemini Observatory</h1>
      <p>המסך הזה פתוח ציבורית רק עם סיסמת גישה.</p>
      ${errorHtml}
      <form method="post" action="/gemini-observatory/login">
        <input type="hidden" name="next" value="${nextValue}" />
        <label for="password">סיסמה</label>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">כניסה</button>
      </form>
      <div class="hint">לאחר האימות תישמר גישה בדפדפן הזה.</div>
    </main>
  </body>
</html>`;
}

export function requireGeminiObservatoryApiAccess(req: Request, res: Response, next: NextFunction) {
  if (hasGeminiObservatoryAccess(req)) {
    next();
    return;
  }

  res.status(401).json({
    error: 'Gemini Observatory password is required',
    authRequired: true,
    loginPath: '/gemini-observatory/login',
  });
}

export function requireGeminiObservatoryPageAccess(req: Request, res: Response, next: NextFunction) {
  if (hasGeminiObservatoryAccess(req)) {
    next();
    return;
  }

  const nextPath = normalizeNextPath(req.originalUrl || req.url);
  res
    .status(401)
    .type('html')
    .send(renderLoginPage(nextPath, false));
}

export function serveGeminiObservatoryLoginPage(req: Request, res: Response) {
  const nextPath = normalizeNextPath(req.query.next || req.query.redirect || '/gemini-observatory');
  res
    .status(200)
    .type('html')
    .send(renderLoginPage(nextPath, false));
}

export function handleGeminiObservatoryLogin(req: Request, res: Response) {
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const nextPath = normalizeNextPath(req.body?.next);

  if (password !== GEMINI_OBSERVATORY_PASSWORD) {
    res
      .status(401)
      .type('html')
      .send(renderLoginPage(nextPath, true));
    return;
  }

  res.cookie(GEMINI_OBSERVATORY_COOKIE, createGeminiObservatoryUnlockToken(req), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    domain: process.env.NODE_ENV === 'production' && CODEX_APP_CONFIG.sessionCookieDomain
      ? CODEX_APP_CONFIG.sessionCookieDomain
      : undefined,
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  res.redirect(nextPath);
}
