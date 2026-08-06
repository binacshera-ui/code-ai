# code-ai

**עמדת שליטה מוביילית לסוכני טרמינל אמיתיים.**

`code-ai` מאחדת את **Codex**, **Claude Code** ו־**Gemini CLI** לתוך סביבת עבודה אחת, נקייה ומוביילית, שנבנתה לביצוע אמיתי ולא לדמו צעצוע. היא יושבת מעל ה־CLI המקומיים האמיתיים שלך, שומרת על ה־homes האמיתיים שלהם, ומוסיפה את שכבת ההפעלה שחסרה כמעט בכל כלי אחר: תורים, תזמון, פרויקטים, הקשר חוזר, מצבי עבודה, דפדפן אמיתי, ושחזורי סשנים.

<p align="center">
  <img src="deploy/code-ai/assets/readme/showcase-hero.png" alt="תצוגת showcase של code-ai" width="100%" />
</p>

<p align="center"><em>כל התמונות בהמשך הן צילומי מובייל חיים מתוך המערכת עצמה.</em></p>

## איך זה מרגיש בפועל

- **ממשק אחד לשלושה ספקים** עם homes אמיתיים ושליטה ייעודית לכל provider.
- **חוויית שיחה מוביילית אמיתית** במקום עטיפת shell שולחנית ומסורבלת.
- **תורים, הרצות חוזרות ומצבי follow-up** לעבודה ארוכה ומסודרת.
- **הקשר חוזר** עם קבצים, עוגנים, סקילים, תזכורות והגבלות פעולה.
- **מצב דפדפן אמיתי ל־Codex** עם Chromium חי ופרופיל persisted.
- **מצב Chrome אישי** שמחבר תוסף Side Panel אל הדפדפן האמיתי במחשב, עם pairing, הרשאות, אישורים ויומן ביקורת לכל סשן.
- **מצב עיצוב Codex × Gemini** שבו Gemini מספק שיקול דעת חזותי וקודקס שומר לבדו על הקוד, הלוגיקה וכל היכולות; קנבס מלא או חיתוך ממנו נשלחים רק לפי החלטה מפורשת בכל ייעוץ.
- **פרויקטים, נושאים, ארכיון והעתקות בין משתמשים** כדי לנהל עבודה גדולה בלי ללכת לאיבוד.

## סיור מוצר

### נקודות כניסה מהירות

<p align="center">
  <img src="deploy/code-ai/assets/readme/showcase-quick-actions.png" alt="פעולות מהירות" width="31%" />
  <img src="deploy/code-ai/assets/readme/showcase-attachments.png" alt="צירופי קבצים והקשר חוזר" width="31%" />
  <img src="deploy/code-ai/assets/readme/showcase-scheduler.png" alt="תזמון חד-פעמי וחוזר" width="31%" />
</p>

- **פעולות מהירות** שומרות את הזרימות העיקריות במרחק לחיצה אחת: שיחה חדשה, הוראה קבועה, עץ קבצים, כלי בדיקה ומשחקים.
- **צירופים** הם הרבה מעבר להעלאת קובץ: אפשר להוסיף קבצים, עוגנים, סקילים, תזכורות ומצבים מתוך נקודת כניסה אחת.
- **תזמון** מאפשר גם הרצה חד־פעמית וגם הרצות מחזוריות בלי לצאת ממסך השיחה.

### שליטה אמיתית על הריצה

<p align="center">
  <img src="deploy/code-ai/assets/readme/showcase-model-panel.png" alt="פאנל מודל והרשאות" width="48%" />
  <img src="deploy/code-ai/assets/readme/showcase-modes.png" alt="מצבי עבודה" width="48%" />
</p>

- **פאנל המודל והחשיבה** מציג את מצב הריצה האמיתי: מודל, עומק חשיבה, הרשאות, sandbox, מהירות תגובה והתנהגות provider.
- **מצבי עבודה** הופכים את אותה שיחה לאחד מהבאים:
  - ריצה רגילה,
  - מצב מקצועי עם תכנון/ביצוע/בדיקה,
  - מצב ביאורים עם דוח follow-up,
  - מצב סשן סוכנים,
  - מצב דפדפן אמיתי,
  - מצב עיצוב עם קנבס ויועץ Gemini מבודד,
  - או מצב הגבלת פעולה לקובץ/תיקייה מסוימים.

### נראות מלאה של סביבת העבודה

<p align="center">
  <img src="deploy/code-ai/assets/readme/showcase-file-tree.png" alt="עץ קבצים" width="48%" />
  <img src="deploy/code-ai/assets/readme/showcase-project-board.png" alt="לוח פרויקטים" width="48%" />
</p>

- **עץ הקבצים** נותן תצוגה חיה של תיקיית העבודה והופך בחירת נתיבים לדבר מעשי גם במובייל.
- **לוח הפרויקטים** מאפשר לקבץ שיחות ליוזמות גדולות, לעקוב אחרי משימות משנה, ולא לתת לעבודה מרובת־סשנים להתפזר.

## מה אפשר לעשות כאן באמת

### להריץ ספקים אמיתיים

- לפתוח שיחת Codex, Claude או Gemini מאותו UI.
- לשמור homes ותיקיות עבודה שונות לכל profile.
- לראות מה המודל באמת שלח לכלים ומה הכלים באמת החזירו.
- להמשיך, למזלג, להעביר, לארכב, להעתיק ולשחזר סשנים בלי לאבד את ההקשר התפעולי.

### לעבוד עם הקשר חוזר במקום לחזור על עצמך

- לצרף קבצים רגילים מהמכשיר או מה־workspace.
- להוסיף **עוגנים** שמצביעים לקבצים או תיקיות חשובים.
- לצרף **סקילים** כהקשר תפעולי חוזר.
- לשמור **תזכורות** מכל הודעה ולהזריק אותן שוב בהמשך.
- להפעיל **מצב הגבלת פעולה** כדי להנחות את המודל לערוך רק קובץ או תיקייה מסוימים, ובמקרים שאפשר לזהות — גם לדחות שינויים חורגים בצד השרת.

### להפעיל מצבי עבודה ברמה גבוהה יותר

- **מצב מקצועי** יוצר תור של תכנון / ביצוע / בדיקה.
- **מצב ביאורים** יוצר את המשימה הראשית ואז משימת follow-up שמפיקה דוח Markdown בעברית.
- **מצב סשן סוכנים** מתכנן ומנהל child agents סביב יוזמה גדולה.
- **מצב דפדפן אמיתי** מחבר ל־Codex דפדפן Chromium אמיתי עם כלים לניווט, קריאה, טפסים, JavaScript, צילומי מסך, קונסול, רשת וטאבים.
- **מצב Chrome אישי** מחבר לסשן מסוים את Chrome במחשב של המשתמש. קודקס מקבל כלים לטאבים, DOM, בחירת רכיב או אזור, לחיצות, הקלדה, טפסים, צילומי מסך, קונסול, רשת ו־JavaScript; פעולות מסוכנות עוברות אישור לפי המדיניות שנבחרה.
- **מצב עיצוב** טוען רק לסשן הפעיל סקיל וכלי MCP ייעודיים. קודקס בוחר בכל קריאה אם להשמיט את הקנבס, לשלוח אותו במלואו או לשלוח חיתוך ממוקד, ו־Gemini מחזיר מפרט עיצוב בלבד — לא patch ולא שינוי קוד.

### לעבוד כמו מפעיל כוח

- להריץ כמה משימות בתור במקום להיתקע על foreground יחיד.
- לתזמן משימות חד־פעמיות או קבועות.
- לארגן שיחות לפי **נושאים** ו־**פרויקטים**.
- להעתיק שיחות בין משתמשים.
- להעיר סשן רגיל ממערכת חיצונית דרך trigger endpoint.
- לעבוד במצב תמיכה מבודד כשצריך זרימת support פנימית.

## למה זה שונה

רוב המעטפות סביב מודלי קוד נעצרות ב־“שלח prompt, קבל תשובה”.
`code-ai` מתייחסת ל־**אופרציה של סשנים** כאל מוצר בפני עצמו:

- מצב שיחה,
- תור הרצות,
- תיעוד וכלים,
- הקשר חוזר,
- הרשאות,
- artifacts,
- recovery,
- והבדלים אמיתיים בין ספקים.

לכן הממשק בנוי סביב:

- רציפות שיחה,
- עומק queue,
- staging של ביצוע,
- זיכרון שימושי,
- controls מודעי־provider,
- ותצפית על ה־runtime המקומי האמיתי.

## סקירה טכנית

אם באת בשביל הסיור המוצרי, אפשר לעצור כאן.
מכאן והלאה זה החלק של המפעיל וההתקנה.

### המחסנית המרכזית

- **Frontend**: React + Vite, מותאם לשימוש מובייל.
- **Backend**: שכבת Node/Express שמנתבת לפי provider ומנהלת queue, parsing ואורקסטרציה.
- **Providers**: Codex CLI, Claude CLI, Gemini CLI.
- **State**: אחסון מקומי של האפליקציה, metadata של סשנים, queue data ו־provider homes.

### מושגים שחשוב להכיר

#### `workspaceCwd`

תיקיית העבודה הדיפולטיבית עבור שיחות חדשות.

#### `codexHome`

שם legacy לשדה שמחזיק את בית הפרופיל של הספק הנבחר.

דוגמאות:

- Codex -> `.codex`
- Claude -> `.claude`
- Gemini -> `.gemini`

השם נשאר `codexHome` לצורכי תאימות, אבל בפועל מדובר ב־**provider home** כללי.

### מביאים את הספקים שלכם

דרישות בסיס:

- Node.js 20 ומעלה
- npm
- Git
- Python 3 עבור מצב הדפדפן האמיתי

CLIים אופציונליים:

- Codex CLI
- Claude CLI
- Gemini CLI

אפשר לעבוד עם ספק אחד בלבד או עם כל השלושה.

### התחלה מהירה

#### Linux / macOS

```bash
git clone <repository-url>
cd code-ai
./install.sh \
  --app-name code-ai \
  --port 4000 \
  --profiles-json '[{"id":"codex-main","label":"Codex","provider":"codex","codexHome":"/home/ubuntu/.codex","workspaceCwd":"/srv/workspace","defaultProfile":true},{"id":"claude-main","label":"Claude","provider":"claude","codexHome":"/home/ubuntu/.claude","workspaceCwd":"/srv/workspace"},{"id":"gemini-main","label":"Gemini","provider":"gemini","codexHome":"/home/ubuntu/.gemini","workspaceCwd":"/srv/workspace"}]' \
  --device-password change-me-now \
  --session-secret change-me-too
```

#### Windows PowerShell

```powershell
git clone <repository-url>
cd code-ai
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  --app-name code-ai `
  --port 4000 `
  --profiles-json '[{"id":"codex-main","label":"Codex","provider":"codex","codexHome":"C:\\Users\\Administrator\\.codex","workspaceCwd":"D:\\workspace","defaultProfile":true},{"id":"claude-main","label":"Claude","provider":"claude","codexHome":"C:\\Users\\Administrator\\.claude","workspaceCwd":"D:\\workspace"},{"id":"gemini-main","label":"Gemini","provider":"gemini","codexHome":"C:\\Users\\Administrator\\.gemini","workspaceCwd":"D:\\workspace"}]' `
  --device-password change-me-now `
  --session-secret change-me-too
```

> המתקין מכין גם את סביבת ה־Python של מצב הדפדפן ומתקין Chromium של Playwright אם לא דילגת על שלב זה.

### מבנה הריפו

- `client/` — ממשק המובייל
- `server/` — ניתוב ספקים, queue, parsing ואורקסטרציה
- `chrome-extension/` — תוסף Manifest V3 ל־Side Panel ולחיבור הדפדפן האמיתי
- `deploy/code-ai/` — מתקין, exporter ונכסי deployment
- `scripts/` — כלי עזר מקומיים
- `ecosystem.config.cjs` — תהליך PM2

### הערות פריסה

המתקין יודע:

- לכתוב `.env`
- לכתוב `CODEX_PROFILES_JSON`
- ליצור storage לאפליקציה
- להתקין תלויות
- לבצע build מלא ללקוח ולשרת
- להכין את runtime של מצב הדפדפן
- להעלות או לרענן PM2

### תוסף Chrome אישי

זהו מצב נפרד מדפדפן Chromium המבודד שרץ בשרת. התוסף שולט רק במכשיר שהמשתמש חיבר במפורש ורק לאחר שיוך לסשן מסוים.

```bash
npm run extension:package -- \
  --output /tmp/code-ai-personal-chrome \
  --control-origin https://your-code-ai.example
```

ב־Chrome פותחים `chrome://extensions`, מפעילים **מצב מפתח**, לוחצים **טעינת פריט שלא נארז** ובוחרים את התיקייה שנוצרה. לאחר מכן פותחים ב־CODE-AI את **מצבים ← Chrome אישי**, יוצרים קוד חד־פעמי, מחברים את התוסף, בוחרים מכשיר, מגדירים היקפי קריאה/כתיבה ומדיניות אישור, ומפעילים את המצב לסשן.

כל שיוך ניתן לביטול והוא פרטי לסשן. ערכים רגישים מוסתרים מתצוגות האישור ומיומן הביקורת. הנגשת פורטים נקשרת רק ל־`127.0.0.1`, מוגבלת בזמן וניתנת לסגירה מיידית. פירוט הרשאות ומודל האיום נמצא ב־`chrome-extension/README.md`.

### לקריאה נוספת

- `README.md` — הגרסה באנגלית
- `AGENT.he.md` — הנחיות תפעול והעברה
- `WINDOWS.FIELD-NOTES.he.md` — הערות שטח ל־Windows
- `deploy/code-ai/install.mjs` — המתקין הראשי
- `server/config.ts` — הגדרות profiles ואחסון
- `client/src/components/codex/CodexMobileApp.tsx` — מעטפת ה־UI הראשית

### SSH נכנס פרטי למחשב אישי

סוכן המחשב האישי יכול להעביר במנהרה היוצאת הקיימת גם ערוץ SSH אופציונלי.
כך ניתן להתחבר למחשב שנמצא מאחורי NAT בלי לפתוח את OpenSSH שלו לאינטרנט.

מוסיפים לקובץ ה־pairing הפרטי:

```dotenv
CODEX_REMOTE_SSH_REVERSE_PORT=44022
CODEX_REMOTE_SSH_LOCAL_PORT=22
```

שתי המנהרות נקשרות בשרת הבקרה ל־`127.0.0.1` בלבד. במחשב האישי יש להתקין
ולהפעיל OpenSSH Server, לאשר מפתח ציבורי ייעודי של שרת הבקרה, ולהשאיר את
כלל חומת האש הציבורי של Windows כבוי אלא אם נדרשת במפורש גישת LAN ישירה.
לאחר שהמנהרה פעילה מתחברים משרת הבקרה באמצעות
`ssh -p 44022 <windows-user>@127.0.0.1`.
