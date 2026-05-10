# AGENT.he.md

גרסה באנגלית:

- `AGENT.md`

זהו קובץ ההנחיות המרכזי למפעילים ולסוכני AI שעובדים עם `code-ai`.

`code-ai` היא סביבת עבודה מוביילית שמפעילה 3 ספקי סוכני קוד מתוך ממשק אחד:

- Codex
- Claude Code
- Gemini CLI

הקובץ הזה מיועד למצבים של התקנה, עדכון, דיבוג, חקירת תקלות, שחזור נתונים, או מסירת המערכת לסוכן/מפעיל אחר.

## מה לקרוא קודם

אם צריך להבין מהר:

1. `README.he.md`
2. `deploy/code-ai/install.mjs`
3. `server/config.ts`
4. `server/agentService.ts`
5. `client/src/components/codex/CodexMobileApp.tsx`

## מה הריפו הזה באמת

- סביבת עבודה מוביילית רב-ספקית
- צד לקוח + צד שרת
- queue משותף, scheduling, uploads, titles, topics, hidden/archive
- העברות בין Codex, Claude ו־Gemini
- parsing של שיחות מתוך האחסון האמיתי של כל CLI

## חוק השמות שחייבים להבין

עדיין יש הרבה שמות עם `codex`:

- `/api/codex/*`
- `CODEX_PROFILES_JSON`
- `server/codexRoutes.ts`
- `server/codexQueue.ts`
- `server/codexService.ts`
- `client/src/components/codex/...`

אלה שמות legacy לצורכי תאימות לאחור.

במערכת של היום, הם כבר לא אומרים "Codex בלבד". הם חלק מהמבנה ההיסטורי של `code-ai`.

## קבצי ההיגיון הראשיים

אלה הקבצים שבאמת מגדירים את ההתנהגות:

- `server/config.ts`
  profiles, providers, נתיבים ו־storage roots
- `server/agentService.ts`
  שכבת ניתוב אחת בין Codex / Claude / Gemini
- `server/codexService.ts`
  parsing והרצה של Codex
- `server/claudeService.ts`
  parsing והרצה של Claude
- `server/geminiService.ts`
  parsing והרצה של Gemini
- `server/codexQueue.ts`
  queue משותף, scheduling, retries, orchestration
- `server/codexForkSessions.ts`
  draft forks ומטא־דאטה של העברות בין ספקים
- `server/codexRoutes.ts`
  שכבת ה־HTTP של המערכת
- `client/src/components/codex/CodexMobileApp.tsx`
  הממשק הראשי

## ההתקנה הכי מהירה והכי בטוחה

### Linux / macOS

```bash
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --profiles-json '[{"id":"codex-main","label":"Codex","provider":"codex","codexHome":"/home/ubuntu/.codex","workspaceCwd":"/srv/workspace","defaultProfile":true},{"id":"claude-main","label":"Claude","provider":"claude","codexHome":"/home/ubuntu/.claude","workspaceCwd":"/srv/workspace"},{"id":"gemini-main","label":"Gemini","provider":"gemini","codexHome":"/home/ubuntu/.gemini","workspaceCwd":"/srv/workspace"}]' \
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
  --profiles-json '[{"id":"codex-main","label":"Codex","provider":"codex","codexHome":"C:\\Users\\Administrator\\.codex","workspaceCwd":"D:\\workspace","defaultProfile":true},{"id":"claude-main","label":"Claude","provider":"claude","codexHome":"C:\\Users\\Administrator\\.claude","workspaceCwd":"D:\\workspace"},{"id":"gemini-main","label":"Gemini","provider":"gemini","codexHome":"C:\\Users\\Administrator\\.gemini","workspaceCwd":"D:\\workspace"}]' `
  --device-password change-me-now `
  --session-secret change-me-too
```

## מה חייב להיות על השרת

בסיס:

- Node.js 20 ומעלה
- npm
- Git

בינארים של הספקים:

- `codex`
- `claude`
- `gemini`

אם צריך נתיב מפורש:

- `CODEX_BIN`
- `CLAUDE_BIN`
- `GEMINI_BIN`

תיקיות home אמיתיות:

- Codex -> `.codex`
- Claude -> `.claude`
- Gemini -> `.gemini`

חשוב:

- השדה ב־JSON עדיין נקרא `codexHome`
- בתוך `code-ai` המשמעות שלו היא "home של הספק", לא "Codex בלבד"

## שני מושגי הנתיב ששוברים התקנות

### `workspaceCwd`

זו תיקיית העבודה הדיפולטיבית לשיחות חדשות.

### `codexHome`

זה שם legacy ל־provider data home.

דוגמאות:

- Codex: `/home/ubuntu/.codex`
- Claude: `/home/ubuntu/.claude`
- Gemini: `/home/ubuntu/.gemini`

אם משתמש אומר "השיחות הישנות חסרות", זה המקום הראשון לבדוק.

## מבנה הריפו

- `client/` — ה־UI
- `server/` — ה־API והאורקסטרציה
- `deploy/code-ai/` — install/export/nginx
- `ecosystem.config.cjs` — PM2
- `.env.example` — מבנה הסביבה

## storage של האפליקציה

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

## איפה באמת נמצאות השיחות

לא בתוך `.code-ai`.

צריך לבדוק את תיקיית הבית של הספק הנבחר.

Codex:

- `session_index.jsonl`
- `sessions/`
- `archived_sessions/`

Claude:

- `projects/<workspace>/*.jsonl`
- `projects/<workspace>/memory/`
- `projects/<workspace>/<session>/subagents/`

Gemini:

- `projects.json`
- `tmp/<project-id>/chats/*.jsonl`

## מפת תקלות מהירה

### "שיחות ישנות לא מופיעות"

בדוק:

- `.env`
- `CODEX_PROFILES_JSON`
- home של הספק הפעיל
- קבצי sessions של אותו ספק
- `session-visibility.json`

### "משימה מתוזמנת נעלמה"

בדוק:

- `CODEX_QUEUE_ROOT/state.json`
- `server/codexQueue.ts`
- `npx pm2 logs <app-name>`

### "העברה בין ספקים נראית לא נכון"

בדוק:

- `server/codexForkSessions.ts`
- `server/codexQueue.ts`
- `server/agentService.ts`
- קובץ השירות של הספק היעד

### "קבצים שהועלו נעלמו"

בדוק:

- `CODEX_UPLOAD_ROOT`
- `/api/codex/uploads`
- `logs/file-access.jsonl`

### "ה־UI עולה אבל אין תפקוד"

בדוק:

- `.env`
- `CODEX_PROFILES_JSON`
- שהבינארי של הספק הרלוונטי עובד
- `npx pm2 logs <app-name>`

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

Entrypoints ישירים:

```bash
node deploy/code-ai/install.mjs --help
node deploy/code-ai/export-standalone.mjs --help
```

## איך מעדכנים התקנה קיימת

```bash
git pull
npm install --include=dev
npm run build
npx pm2 restart code-ai --update-env
```

אם PM2 עדיין משתמש בשם ברירת המחדל, השתמש ב־`code-ai-app`.

## איך מייצאים standalone

```bash
npm run export:standalone
```

או ישירות:

```bash
node deploy/code-ai/export-standalone.mjs /tmp/code-ai-standalone --git-init
```

הייצוא שומר בכוונה:

- `README.md`
- `README.he.md`
- `AGENT.md`
- `AGENT.he.md`
- `.env.example`
- `install.*`
- `export-standalone.*`

לא למחוק אותם.

## משתני הסביבה הכי חשובים

- `PORT`
- `PM2_APP_NAME`
- `CODEX_BIN`
- `CLAUDE_BIN`
- `GEMINI_BIN`
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

## על מה לא לבזבז זמן

- לערוך `dist/` ידנית
- לחפש transcript history בתוך `.code-ai/`
- להניח ש־`CODEX_STORAGE_ROOT` הוא היסטוריית הצ'אטים
- לרדוף אחרי DNS/nginx לפני שבדקת לוקלית שהאפליקציה עצמה חיה

## צ'קליסט מינימלי להתקנה שבורה

1. פתח `.env`
2. ודא ש־`CODEX_PROFILES_JSON` מצביע לנתיבים אמיתיים וקריאים
3. ודא שלתיקיות ה־storage יש הרשאות כתיבה
4. ודא שהבינארי של הספק הרלוונטי עובד:
   - `codex --help`
   - `claude --help`
   - `gemini --help`
5. הרץ `npm run build`
6. הרץ `npx pm2 describe <app-name>`
7. הרץ `npx pm2 logs <app-name>`
8. אם חסרות שיחות, בדוק ישירות את תיקיית הבית של הספק
