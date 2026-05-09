# AGENT.he.md

זהו קובץ ההנחיות בעברית עבור מפעילים אנושיים או סוכני AI שעובדים עם ריפו `code-ai`.

אם צריך להבין מהר מאוד מה לעשות:

1. קרא את `README.he.md`
2. קרא את `deploy/code-ai/install.mjs`
3. קרא את `server/config.ts`
4. קרא את `server/codexService.ts`

## מה הריפו הזה מכיל

- אפליקציית code-ai המלאה
- צד לקוח `client/`
- צד שרת `server/`
- queue, scheduling, uploads, titles, topics, visibility, session instructions
- חיבור ל־Codex CLI המקומי

## ההתקנה הכי מהירה והכי בטוחה

### Linux / macOS

```bash
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --codex-home /home/ubuntu/.codex \
  --workspace /srv/codex-workspace \
  --device-password change-me-now \
  --session-secret change-me-too
```

### Windows PowerShell

```powershell
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  --app-name code-ai `
  --port 4000 `
  --codex-home C:\Users\Administrator\.codex `
  --workspace D:\codex-workspace `
  --device-password change-me-now `
  --session-secret change-me-too
```

הסקריפט הזה:

- כותב `.env`
- מתקין תלויות
- בונה client + server
- יוצר storage
- מעלה או מרענן PM2

## שני הנתיבים שחייבים להיות נכונים

### `codexHome`

זה הבית האמיתי של Codex עבור אותו פרופיל.

הוא אמור לכלול:

- `session_index.jsonl`
- `sessions/`
- לפעמים `archived_sessions/`
- בדרך כלל `config.toml`

אם לא רואים היסטוריית צ'אטים, זה המקום הראשון לבדוק.

### `workspace`

זו תיקיית העבודה הדיפולטיבית לשיחות חדשות.

## קבצים ראשונים שצריך לקרוא

- `README.md` ו־`README.he.md`
- `deploy/code-ai/install.mjs`
- `server/config.ts`
- `server/index.ts`
- `server/codexRoutes.ts`
- `server/codexService.ts`
- `server/codexQueue.ts`
- `client/src/components/codex/CodexMobileApp.tsx`

## מבנה הריפו

- `client/` — ה־UI
- `server/` — ה־API, queue, parsing וחיבור ל־Codex CLI
- `deploy/code-ai/` — מתקין, exporter ותבנית nginx
- `ecosystem.config.cjs` — הגדרת PM2
- `.env.example` — תבנית סביבה

## איפה נשמרים דברים

### storage של האפליקציה

ברירת מחדל תחת `CODEX_STORAGE_ROOT`:

- `uploads/`
- `queue/state.json`
- `queue/fork-sessions.json`
- `session-titles.json`
- `session-topics.json`
- `session-visibility.json`
- `session-instructions.json`
- `logs/client-crashes.jsonl`
- `logs/server-crashes.jsonl`
- `logs/file-access.jsonl`

### איפה נמצאים הצ'אטים האמיתיים

לא בתוך storage של האפליקציה.

הם נמצאים בתוך `codexHome` של כל פרופיל:

- `session_index.jsonl`
- `sessions/`
- `archived_sessions/`

אם מישהו אומר:

- "הצ'אט לא מופיע"
- "השיחות הישנות נעלמו"
- "תמצא לי את ההיסטוריה"

צריך לבדוק קודם את `codexHome`, לא את `.code-ai/`.

## מפת תקלות מהירה

### "שיחות ישנות לא מופיעות"

בדוק:

- `.env`
- `CODEX_PROFILES_JSON`
- `codexHome`
- `codexHome/session_index.jsonl`
- `codexHome/sessions/`
- `session-visibility.json`

### "משימה מתוזמנת נעלמה"

בדוק:

- `CODEX_QUEUE_ROOT/state.json`
- `server/codexQueue.ts`
- `npx pm2 logs <app-name>`

### "קובץ שהועלה לא נמצא"

בדוק:

- `CODEX_UPLOAD_ROOT`
- `/api/codex/uploads`
- `logs/file-access.jsonl`

### "כותרת / נושא / ארכיון נעלמו"

בדוק:

- `session-titles.json`
- `session-topics.json`
- `session-visibility.json`

### "הוראה קבועה של סשן נעלמה"

בדוק:

- `session-instructions.json`

### "ה־UI עולה אבל אין תפקוד"

בדוק:

- `npx pm2 logs <app-name>`
- `CODEX_BIN`
- `CODEX_PROFILES_JSON`
- האם `codex --help` עובד על המכונה

## פקודות שבאמת צריך

```bash
./install.sh --help
./export-standalone.sh --help
npm install --include=dev
npm run build
npx pm2 describe code-ai
npx pm2 logs code-ai
npx pm2 restart code-ai --update-env
```

## איך לעדכן התקנה קיימת

```bash
git pull
npm install --include=dev
npm run build
npx pm2 restart code-ai --update-env
```

אם שם ה־PM2 נשאר ברירת מחדל, השתמש ב־`code-ai-app`.

## משתני סביבה חשובים

- `PORT`
- `PM2_APP_NAME`
- `CODEX_BIN`
- `CODEX_PROFILES_JSON`
- `CODEX_STORAGE_ROOT`
- `CODEX_UPLOAD_ROOT`
- `CODEX_QUEUE_ROOT`
- `CODEX_LOG_ROOT`
- `CODEX_DEVICE_ADMIN_PASSWORD`
- `CODEX_ALLOW_ANY_PATHS`
- `CODEX_ALLOWED_FILE_ROOTS`
- `SESSION_SECRET`
- `SESSION_COOKIE_DOMAIN`
- `DATABASE_URL`

## מה לא לבזבז עליו זמן

- לא לערוך `dist/` ידנית
- לא לחפש transcript history בתוך `.code-ai/`
- לא לבלבל בין `CODEX_STORAGE_ROOT` לבין היסטוריית הצ'אטים האמיתית
- לא לנסות לתקן DNS/nginx מתוך הריפו הזה

## אם ההתקנה שבורה

1. פתח `.env`
2. ודא ש־`CODEX_PROFILES_JSON` מצביע לנתיבים אמיתיים
3. ודא של־`CODEX_STORAGE_ROOT`, `CODEX_UPLOAD_ROOT`, `CODEX_QUEUE_ROOT`, ו־`CODEX_LOG_ROOT` יש הרשאות כתיבה
4. ודא ש־`codex --help` עובד או שהנתיב ב־`CODEX_BIN` תקין
5. הרץ `npm run build`
6. בדוק `npx pm2 describe <app-name>`
7. בדוק `npx pm2 logs <app-name>`
8. אם הצ'אטים חסרים, בדוק `codexHome/session_index.jsonl` ו־`codexHome/sessions/`

## קבצי handoff שחייבים להישאר

אל תמחק:

- `README.md`
- `README.he.md`
- `AGENT.md`
- `AGENT.he.md`
- `.env.example`
- `install.*`
- `export-standalone.*`

אלה לא קבצים מיותרים. הם חלק ממסירת המערכת לאחרים.
