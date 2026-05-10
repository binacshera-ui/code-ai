# ערכת פריסה ל־code-ai

גרסה באנגלית:

- `README.md`

הערות שטח ל־Windows:

- `WINDOWS.FIELD-NOTES.he.md`

`code-ai` היא סביבת עבודה מוביילית לשליטה ב־3 סוכני הקוד המובילים מתוך ממשק אחד:

- Codex
- Claude Code
- Gemini CLI

זה כבר לא "ממשק לקודקס". זו שכבת שליטה אחת שמחברת כמה ספקים, תורים, תיזמון, uploads, העברות בין ספקים, והיסטוריית שיחות לפי ה־home האמיתי של כל provider.

## מה חייב להיות מותקן

בסיס:

- Node.js 20 ומעלה
- npm
- Git

ספקים:

- Codex CLI אם רוצים לעבוד עם Codex
- Claude CLI אם רוצים לעבוד עם Claude
- Gemini CLI אם רוצים לעבוד עם Gemini

מצב authentication / state:

- לפרופילי Codex צריך להיות `.codex` אמיתי
- לפרופילי Claude צריך להיות `.claude` אמיתי
- לפרופילי Gemini צריך להיות `.gemini` אמיתי

חשוב:

- אפשר להפעיל את `code-ai` גם עם ספק אחד בלבד.
- כדי לקבל את כל החוויה הרב-ספקית, כל 3 ה־CLI צריכים להיות מותקנים ומחוברים על השרת.

## ההתקנה הכי מהירה

אם המטרה היא להרים את המערכת נכון מההתחלה, השתמש ב־`profiles-json` מפורש עם 3 הספקים.

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

### Windows CMD

```cmd
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
install.cmd --app-name code-ai --port 4000 --profiles-json "[{\"id\":\"codex-main\",\"label\":\"Codex\",\"provider\":\"codex\",\"codexHome\":\"C:\\Users\\Administrator\\.codex\",\"workspaceCwd\":\"D:\\workspace\",\"defaultProfile\":true},{\"id\":\"claude-main\",\"label\":\"Claude\",\"provider\":\"claude\",\"codexHome\":\"C:\\Users\\Administrator\\.claude\",\"workspaceCwd\":\"D:\\workspace\"},{\"id\":\"gemini-main\",\"label\":\"Gemini\",\"provider\":\"gemini\",\"codexHome\":\"C:\\Users\\Administrator\\.gemini\",\"workspaceCwd\":\"D:\\workspace\"}]" --device-password change-me-now --session-secret change-me-too
```

## הערות שטח ל־Windows

אם ההתקנה היא על Windows, מומלץ מאוד לקרוא גם את:

- `WINDOWS.FIELD-NOTES.he.md`

המסמך הזה מרכז בעיות אמיתיות מהשטח:

- wrappers של `.cmd` ו־`.bat`
- נתיבי CLI אמיתיים מול `PATH`
- `Gemini CLI` על Windows
- reverse proxy / tunnel
- PM2 על Windows
- נתיבים עם רווחים

## מה המתקין עושה בפועל

המתקין הראשי:

- `deploy/code-ai/install.mjs`

ה־wrappers:

- `install.sh`
- `install.ps1`
- `install.cmd`

הוא:

- כותב `.env`
- כותב `CODEX_PROFILES_JSON`
- יוצר storage
- מריץ `npm install --include=dev`
- מריץ `npm run build`
- מעלה או מרענן PM2 דרך `ecosystem.config.cjs`

אין צורך ידני:

- לכתוב `.env`
- להתקין PM2 גלובלית
- ליצור תיקיות queue/uploads/logs
- לבנות client ו־server בנפרד

## שני מושגי הנתיב שחייבים להבין

### `workspaceCwd`

זו תיקיית העבודה הדיפולטיבית שתופיע ב־UI לשיחות חדשות.

### `codexHome`

זה שם legacy, אבל בתוך `code-ai` הכוונה היא:

- תיקיית הנתונים האמיתית של אותו provider

דוגמאות:

- Codex -> `/home/ubuntu/.codex`
- Claude -> `/home/ubuntu/.claude`
- Gemini -> `/home/ubuntu/.gemini`

השדה לא שונה בשם כדי לא לשבור התקנות קיימות, queue state ישן, ו־JSON schema ישן.

## נתיבי הבינארים של הספקים

אם הפקודות כבר ב־`PATH`, לרוב לא צריך להגדיר כלום.

- `CODEX_BIN`
- `CLAUDE_BIN`
- `GEMINI_BIN`

דוגמאות:

- `CODEX_BIN=/usr/local/bin/codex`
- `CLAUDE_BIN=/usr/local/bin/claude`
- `GEMINI_BIN=/home/ubuntu/.local/bin/gemini`

## מבנה הריפו

- `client/` — ה־UI של המובייל
- `server/` — ה־API, ה־queue, והאורקסטרציה
- `deploy/code-ai/` — מתקין, exporter ותבנית nginx
- `ecosystem.config.cjs` — הגדרת PM2
- `.env.example` — מבנה הסביבה

## קבצי ההיגיון הראשיים

אלה הקבצים שבאמת מגדירים את ההתנהגות של `code-ai`:

- `server/config.ts`
  מגדיר profiles, providers, נתיבים ו־storage roots
- `server/agentService.ts`
  שכבת הניתוב הראשית בין Codex / Claude / Gemini
- `server/codexService.ts`
  parsing והרצה של Codex
- `server/claudeService.ts`
  parsing והרצה של Claude
- `server/geminiService.ts`
  parsing והרצה של Gemini
- `server/codexQueue.ts`
  queue משותף, scheduling, retries, fork/transfer execution
- `server/codexForkSessions.ts`
  draft forks ומטא־דאטה של העברות בין ספקים
- `server/codexRoutes.ts`
  שכבת ה־HTTP שהלקוח צורך
- `client/src/components/codex/CodexMobileApp.tsx`
  ממשק המשתמש הראשי

## למה עדיין יש כל כך הרבה שמות עם "codex"

בגלל תאימות לאחור.

לדוגמה:

- `/api/codex/*`
- `CODEX_PROFILES_JSON`
- `server/codexRoutes.ts`
- `server/codexQueue.ts`
- `server/codexService.ts`
- `client/src/components/codex/...`

במערכת הנוכחית, השמות האלה כבר לא אומרים "Codex בלבד". אלה שמות legacy בתוך `code-ai`.

## מה נמצא ב־storage של האפליקציה

שורש ברירת מחדל:

- `CODEX_STORAGE_ROOT`

קבצים נפוצים:

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

## איפה השיחות האמיתיות נשמרות

לא בתוך `.code-ai`.

כל provider שומר את ההיסטוריה במקום שלו:

Codex:

- `session_index.jsonl`
- `sessions/`
- `archived_sessions/`

Claude:

- `projects/<workspace-hash-or-name>/*.jsonl`
- `projects/<workspace>/memory/`
- `projects/<workspace>/<session>/subagents/`

Gemini:

- `projects.json`
- `tmp/<project-id>/chats/*.jsonl`

אם משתמש אומר "הצ'אטים הישנים נעלמו", בודקים קודם את תיקיית הספק, לא את storage של האפליקציה.

## איך בודקים שההתקנה הצליחה

```bash
npx pm2 describe code-ai
npx pm2 logs code-ai
```

ואז פותחים:

- `http://SERVER_IP:4000`

סימנים טובים:

- ה־UI נפתח
- בחירת providers מופיעה
- profiles נטענים
- שיחות ישנות מופיעות עבור הספקים שמותקנים
- שליחת הודעה מייצרת או ממשיכה session אמיתי
- העברה בין ספקים יוצרת handoff draft וממשיכה טבעית

## איך מעדכנים התקנה קיימת

```bash
git pull
npm install --include=dev
npm run build
npx pm2 restart code-ai --update-env
```

אם שם ה־PM2 עדיין `code-ai-app`, השתמש בו במקום `code-ai`.

## ייצוא כריפו standalone

```bash
node deploy/code-ai/export-standalone.mjs /tmp/code-ai-standalone --git-init
```

הייצוא כולל בכוונה:

- `README.md`
- `README.he.md`
- `AGENT.md`
- `AGENT.he.md`
- `.env.example`
- `client/`
- `server/`
- `deploy/code-ai/*`
- `install.*`
- `export-standalone.*`

אל תמחק את הקבצים האלה. הם חלק מחבילת ההעברה.

## צ'קליסט קצר לתקלות

1. ודא שהפקודה של הספק הרלוונטי קיימת:
   - `codex --help`
   - `claude --help`
   - `gemini --help`
2. ודא ש־`CODEX_PROFILES_JSON` מצביע ל־homes אמיתיים וקריאים.
3. ודא שלתיקיות ה־storage יש הרשאות כתיבה.
4. הרץ `npm run build`.
5. בדוק `npx pm2 logs <app-name>`.
6. אם שיחות חסרות, בדוק את תיקיית הספק הרלוונטית, לא את `.code-ai`.
