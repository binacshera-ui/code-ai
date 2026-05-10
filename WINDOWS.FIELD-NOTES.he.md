# הערות שטח: התקנת `code-ai` על Windows

המסמך הזה מרכז לקחים אמיתיים מהתקנת `code-ai` על מכונות Windows, מעבר למסלול ההתקנה הרגיל שמתועד ב־`README.he.md`.

המטרה שלו איננה להחליף את ה־README הראשי, אלא להשלים אותו בנקודות שבדרך כלל מתגלות רק בזמן התקנה אמיתית: נתיבי CLI, wrappers של Windows, PM2, reverse proxy, ומקרי קצה של `Gemini CLI`.

## מתי להשתמש במסמך הזה

השתמש במסמך הזה אם אחד מהמצבים הבאים מתקיים:

- ההתקנה היא על Windows ולא על Linux
- ספק אחד לפחות לא רץ למרות שהפקודה שלו עובדת ידנית בטרמינל
- PM2 עולה אבל הספקים לא מגיבים מתוך האפליקציה
- יש נתיבים עם רווחים
- יש reverse proxy, Cloudflare Tunnel, IIS, Nginx ל־Windows, או port forwarding מול `localhost`

אם מדובר בהתקנה רגילה ונקייה, התחל קודם מה־README הראשי ורק אחר כך חזור לכאן.

## תמונת מצב כללית

בהתקנות Windows שעובדות טוב, יש בדרך כלל 4 שכבות שחייבות להיות עקביות:

1. `Node.js`, `npm`, `Git`, ו־PM2
2. שלושת ה־CLIים:
   - `codex`
   - `claude`
   - `gemini`
3. state אמיתי לכל provider:
   - `.codex`
   - `.claude`
   - `.gemini`
4. סביבת פריסה:
   - פורט האפליקציה
   - reverse proxy / tunnel
   - PM2
   - משתני סביבה

רוב התקלות ב־Windows לא קורות בגלל `code-ai` עצמו, אלא בגלל אי־עקביות בין ארבע השכבות האלה.

## 1. אל תסמוך רק על `PATH`

ב־Windows, העובדה שפקודה מסוימת "עובדת בטרמינל" לא אומרת בהכרח שזה הנתיב הנכון להרצה מתוך Node.js או PM2.

בפועל יש מקרים נפוצים כאלה:

- wrapper מסוג `.cmd`
- wrapper מסוג `.bat`
- `exe` אמיתי
- shim של npm
- entry point שממוקם במקום אחר ממה שנראה ב־`where`

### ההמלצה

אם יש ספק, קבע במפורש את נתיבי הבינארים ב־`.env`:

- `CODEX_BIN`
- `CLAUDE_BIN`
- `GEMINI_BIN`

כאשר `Gemini` ב־Windows מתנהג דרך wrapper או entry file, אפשר להוסיף גם:

- `GEMINI_JS_ENTRY`

### כלל עבודה

אם ספק מסוים עובד ידנית אך לא מתוך `code-ai`, הדבר הראשון שצריך לבדוק הוא מה בדיוק השרת מריץ, לא רק מה פתוח ב־PowerShell.

## 2. `Gemini CLI` הוא המקרה הרגיש ביותר ב־Windows

בפועל, `Gemini CLI` נוטה להיות הספק שהכי מושפע מהבדלים בין התקנה לינוקסית לבין התקנה על Windows.

הגורמים הנפוצים:

- wrapper במקום בינארי ישיר
- תלות ב־`GEMINI_API_KEY`
- state מקומי לא שלם תחת `.gemini`
- trust / policy / admin policy שלא מוגדרים כמו שצריך

### מה צריך לוודא

- שקיים `GEMINI_API_KEY`
- שה־home של Gemini באמת קיים ונגיש
- שהפקודה `gemini` רצה גם לא־אינטראקטיבית
- שאם יש צורך, הוגדר גם `GEMINI_JS_ENTRY`

### בדיקה מומלצת

לפני שמאשימים את `code-ai`, בדוק קודם:

```powershell
gemini --version
gemini -p "Reply with exactly OK." --model flash-lite --yolo
```

אם זה לא עובד ידנית, האפליקציה לא תוכל לייצב את זה לבד.

## 3. wrappers של `.cmd` ו־`.bat` רגישים יותר ממה שנראה

ב־Linux, `spawn` מול binary אמיתי בדרך כלל פשוט עובד.  
ב־Windows, wrappers מוסיפים שכבת שבירות נוספת:

- quoting לא עקבי
- escape של רווחים
- `workdir` שונה מהמצופה
- שינוי התנהגות בין `cmd`, `PowerShell`, ו־Node child process

### ההשלכה המעשית

אם ספק מסוים עובד מהטרמינל אבל לא מתוך השרת, צריך לבדוק:

- האם הוא wrapper ולא executable רגיל
- האם הנתיב שלו כולל רווחים
- האם השרת מריץ אותו מתוך `cwd` נכון
- האם PM2 ירש את הסביבה המעודכנת

## 4. נתיבים עם רווחים הם סיכון תפעולי קבוע

Windows מרשה paths כמו:

`C:\Users\Alice\Documents\New Project`

אבל זה לא אומר שכל כלי חיצוני יטפל בזה באותה יציבות.

### ההמלצה

- להעדיף `workdir` על פני בניית command line ידנית
- לצטט paths רגישים
- להימנע ככל האפשר מ־nested shell commands
- אם צריך התקנה יציבה במיוחד, עדיף להשתמש בנתיב workspace בלי רווחים

זה לא חובה, אבל זה מוריד מאוד את שיעור התקלות.

## 5. reverse proxy / tunnel עלול להיות מקור התקלה, לא האפליקציה

במכונות Windows רבות יש כבר שכבת גישה קיימת:

- Cloudflare Tunnel
- IIS
- Nginx
- port proxy
- local forwarding

בפועל, `code-ai` מאזין בדרך כלל על `4000`, אבל התשתית החיצונית לפעמים עדיין מצביעה על:

- `80`
- `443`
- פורט מקומי ישן

### סימפטום קלאסי

- השירות "רץ"
- `pm2 logs` נראה תקין
- אבל הגישה החיצונית מחזירה `502`, timeout, או דף ישן

### מה לבדוק

- לאיזה פורט `code-ai` באמת מאזין
- לאיזה פורט ה־proxy או ה־tunnel מפנים
- האם קיים process ביניים נוסף שמבצע bridging

אל תניח ש־HTTP failure אומר שהאפליקציה עצמה נשברה.

## 6. צריך להבדיל בין גישה מקומית לבין גישה ציבורית

אם האפליקציה מציגה מסך גישה ציבורי או unlock flow במקום ה־local flow שציפית לו, הבעיה לעיתים קרובות היא לא ב־UI אלא בקונפיגורציית host access.

### שני משתנים קריטיים

- `CODEX_OPEN_ACCESS`
- `CODEX_PUBLIC_HOSTS`

### עיקרון נכון

- `localhost` צריך להישאר מקומי ככל האפשר
- host ציבורי צריך להיות מפורש
- אסור לערבב בין השניים אם רוצים UX צפוי

אם המערכת מזהה בטעות גישה מקומית כגישה ציבורית, בדרך כלל צריך לבדוק קודם את ה־env ולא את הקוד.

## 7. PM2 על Windows דורש משמעת תפעולית

PM2 עובד על Windows, אבל דורש קצת יותר הקפדה מאשר על Linux.

### דברים שחשוב לעשות

- למחוק תהליכים ישנים שכבר לא רלוונטיים
- להפעיל מחדש עם env מעודכן
- לשמור state עם `pm2 save`
- לבדוק שלא רצים גם process ישן וגם process חדש במקביל

### בדיקות בסיס

```powershell
npx pm2 list
npx pm2 describe code-ai
npx pm2 logs code-ai
```

אם יש proxy helper נוסף, צריך לנהל גם אותו כ־PM2 process נפרד או דרך שכבת proxy מסודרת.

## 8. לא כל warning הוא root cause

במהלך התקנה על Windows רואים לעיתים warnings כמו:

- `DATABASE_URL is not set`
- fallback ל־memory session store
- `npm audit` findings
- אזהרות על Store או על cookies

אלה דברים שצריך לטפל בהם בפרודקשן, אבל הם לא בהכרח הסיבה לכך ש־Codex / Claude / Gemini לא רצים.

### סדר עדיפויות נכון

1. ודא שה־CLI עצמו עובד ידנית
2. ודא שהשרת מריץ את אותו binary
3. ודא שה־env נטען נכון
4. ודא שה־proxy מצביע לפורט הנכון
5. רק אז חזור לאזהרות deployment כלליות

## Checklist מומלץ להתקנת Windows

לפני שמכריזים שההתקנה יציבה, מומלץ לעבור על כל הרשימה:

- `node -v`
- `npm -v`
- `git --version`
- `npx pm2 -v`
- `codex --version`
- `claude --version`
- `gemini --version`
- בדיקה לא־אינטראקטיבית לכל provider
- בדיקת `CODEX_BIN` / `CLAUDE_BIN` / `GEMINI_BIN`
- בדיקת `.codex` / `.claude` / `.gemini`
- בדיקת `CODEX_PROFILES_JSON`
- בדיקת `workspaceCwd`
- בדיקת הפורט בפועל
- בדיקת reverse proxy / tunnel
- `npx pm2 logs code-ai`

## סיכום פרקטי

אם רוצים הרמת Windows חלקה ככל האפשר, כדאי לעבוד כך:

1. להתקין קודם את שלושת ה־CLIים ולוודא שכל אחד מהם עובד לבד.
2. להגדיר נתיבי binaries מפורשים אם יש ספק.
3. להימנע עד כמה שאפשר מ־workspace עם paths מורכבים ורוויי רווחים.
4. לאמת את ה־env לפני restart ראשון.
5. לבדוק במפורש את שכבת ה־proxy או ה־tunnel.
6. רק אחרי שכל זה תקין, לחבר את הכול ל־PM2 ולשמור state.

זה בדרך כלל חוסך את רוב הבעיות שמרגישות כמו "באג באפליקציה", אבל בפועל הן בעיות סביבה של Windows.
