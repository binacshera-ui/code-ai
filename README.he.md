# ערכת פריסה ל־code-ai

המסמך הזה נועד לאפשר התקנה מהירה, ברורה, וכמה שפחות מתישה של code-ai על מכונה חדשה.

אם אתה רוצה רק "להרים את המערכת מהר", תעתיק את אחת הפקודות הבאות כמו שהן. הסקריפט יכתוב `.env`, יתקין תלויות, יבנה את האפליקציה, ייצור תיקיות storage, ויעלה את PM2 בשבילך.

## התקנה הכי מהירה

### Linux / macOS

```bash
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --codex-home /home/ubuntu/.codex \
  --workspace /srv/codex-workspace
```

### Windows PowerShell

```powershell
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  --app-name code-ai `
  --port 4000 `
  --codex-home C:\Users\Administrator\.codex `
  --workspace D:\codex-workspace
```

### Windows CMD

```cmd
git clone https://github.com/binacshera-ui/code-ai.git
cd code-ai
install.cmd --app-name code-ai --port 4000 --codex-home C:\Users\Administrator\.codex --workspace D:\codex-workspace
```

## מה צריך לפני שמריצים

חובה:

- Node.js 20 ומעלה
- npm
- Codex CLI מותקן ועובד ב־`PATH`

מה שחייבים לדעת מראש:

- `codexHome`
- `workspace`

### מה זה `codexHome`

זה הבית האמיתי של Codex עבור הפרופיל. זה הנתיב שבו Codex שומר את ההיסטוריה האמיתית של הסשנים.

הוא אמור לכלול:

- `session_index.jsonl`
- `sessions/`
- לפעמים גם `archived_sessions/`
- בדרך כלל גם `config.toml`

אם המשתמש אומר "הצ'אטים הישנים לא הופיעו", ברוב המקרים זו הבעיה.

### מה זה `workspace`

זו תיקיית העבודה הדיפולטיבית שתופיע ב־UI לשיחות חדשות.

דוגמאות:

- Linux:
  `--codex-home /home/ubuntu/.codex`
  `--workspace /srv/codex-workspace`
- Windows:
  `--codex-home C:\Users\Administrator\.codex`
  `--workspace D:\codex-workspace`

אם `codex` לא זמין ב־`PATH`, הוסף:

- `--codex-bin /full/path/to/codex`

## מה המתקין עושה בפועל

המתקין הראשי הוא:

- `deploy/code-ai/install.mjs`

הוא:

- יוצר `.env`
- כותב `CODEX_PROFILES_JSON`
- יוצר תיקיות uploads, queue ו־logs
- מריץ `npm install --include=dev`
- מריץ `npm run build`
- מעלה או מרענן את האפליקציה דרך PM2

כלומר אין צורך ידני:

- לכתוב `.env`
- להתקין PM2 גלובלית
- לבנות client/server בנפרד
- ליצור storage ידנית

## ההתקנה הכי קטנה שעובדת

```bash
./install.sh --codex-home /home/ubuntu/.codex --workspace /srv/codex-workspace
```

ברירות המחדל במקרה הזה:

- app name: `code-ai-app`
- port: `4000`
- open access: `true`
- allow any paths: `true`

## התקנה מומלצת לפרודקשן

```bash
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --codex-home /home/ubuntu/.codex \
  --workspace /srv/codex-workspace \
  --storage-root /srv/code-ai-data \
  --device-password change-me-now \
  --session-secret change-me-too
```

## התקנה עם כמה פרופילים

אם אתה רוצה יותר מפרופיל אחד, השתמש ב־`--profiles-json`.

```bash
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --profiles-json '[{"id":"default","label":"Default","codexHome":"/home/ubuntu/.codex","workspaceCwd":"/srv/codex-workspace","defaultProfile":true},{"id":"ops","label":"Ops","codexHome":"/srv/codex/ops-home","workspaceCwd":"/srv/ops-workspace"}]'
```

## איך מוודאים שההתקנה הצליחה

```bash
npx pm2 describe code-ai
npx pm2 logs code-ai
```

ואז לפתוח:

- `http://SERVER_IP:4000`

סימנים טובים:

- ה־UI נפתח
- הפרופילים נטענים
- צ'אטים ישנים מופיעים
- שליחת הודעה יוצרת או ממשיכה session אמיתי של Codex

## איפה נמצאים הקבצים החשובים

### בתוך הריפו

- `.env`
- `ecosystem.config.cjs`
- `AGENT.md`
- `AGENT.he.md`

### בתוך storage של האפליקציה

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

### איפה באמת נמצאים הצ'אטים

לא תחת `CODEX_STORAGE_ROOT`.

היסטוריית הצ'אטים האמיתית של Codex נמצאת בתוך כל `codexHome`:

- `session_index.jsonl`
- `sessions/`
- `archived_sessions/`

## הטעות הכי נפוצה

המערכת עולה, אבל לא רואים שיחות ישנות, כי `--codex-home` מצביע למקום הלא נכון.

לפני שמחפשים באג, ודא שהנתיב באמת מכיל:

- `session_index.jsonl`
- `sessions/`

## איך מעדכנים את המערכת

```bash
git pull
npm install --include=dev
npm run build
npx pm2 restart code-ai --update-env
```

אם ה־PM2 app name שלך עדיין ברירת המחדל, החלף ל־`code-ai-app`.

## דגלים שימושיים של המתקין

- `--app-name NAME`
- `--port PORT`
- `--codex-home PATH`
- `--workspace PATH`
- `--profile-id ID`
- `--profile-label LABEL`
- `--profiles-json JSON`
- `--storage-root PATH`
- `--public-hosts CSV`
- `--open-access true|false`
- `--allow-any-paths true|false`
- `--extra-readable-roots /srv/shared,/mnt/data`
- `--database-url postgresql://...`
- `--session-secret VALUE`
- `--cookie-domain VALUE`
- `--device-password VALUE`
- `--codex-bin PATH`
- `--skip-npm-install`
- `--skip-build`
- `--skip-pm2`

עזרה מלאה:

```bash
./install.sh --help
node deploy/code-ai/install.mjs --help
```

## Reverse Proxy

המתקין לא נוגע ב־DNS או nginx.

השתמש ב:

- `deploy/code-ai/nginx-site.conf.template`

ותפנה אותו לפורט שבחרת.

## ייצוא כריפו standalone

```bash
node deploy/code-ai/export-standalone.mjs /tmp/code-ai-standalone --git-init
```

PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\code-ai\export-standalone.ps1 C:\temp\code-ai-standalone --git-init
```

הייצוא כולל:

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

## אם אתה רוצה מסלול הכי פחות שביר

1. ודא ש־`codex --help` עובד.
2. ודא ש־`codexHome` האמיתי כולל `sessions/`.
3. הרץ התקנה עם `--codex-home` ו־`--workspace` מפורשים.
4. קבע `--device-password` ו־`--session-secret` משלך.
5. בדוק `npx pm2 logs <app-name>`.
6. פתח את ה־UI וודא שהשיחות הישנות נראות לפני עלייה לפרודקשן.
