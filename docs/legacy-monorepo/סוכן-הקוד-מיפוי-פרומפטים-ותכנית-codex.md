# סוכן הקוד: מצב חי ותכנון היעד

עודכן: 2026-06-03

## מטרת המסמך

לתאר את מצב סוכן הקוד **החי עכשיו בקוד**, ואת מה שעוד נשאר לשפר בהמשך.
זה לא מסמך היסטורי, לא יומן החלטות, ולא תיאור של מה שהיה לפני הסבבים האחרונים.

---

## 1. מצב חי עכשיו

### 1.1 מקור האמת לפרומפטים

פרומפטי הסוכן נטענים מ־`APP-DATA compat` דרך `פרומפטי מערכת כלליים`.

שורות פעילות:

- `קוד רגיל`
- `קוד פרימיום`

עמודות פעילות בפועל:

- `E` — פרומפט הסוכן הראשי
- `G` — פרומפט האיפיון של הבקר
- `I` — פרומפט הארכיטקט
- `O` — פרומפט worker פעיל

עמודת `S` עדיין קיימת בשכבת הנתונים, אבל **אינה משמשת כפרומפט נפרד לשער התקינות** במסלול החי.

עוגנים:

- [config.js](/root/projects/bina-cshera/MAKE2/unified/core/code/config.js)
- [main.js](/root/projects/bina-cshera/MAKE2/unified/core/code/main.js)

### 1.2 payload הכניסה

סוכן הקוד כבר לא עובד על webhook body גולמי כקלט ראשי.
הקלט הפעיל הוא:

- `original_request_id`
- `thread_id`
- `message_id`
- `full_user_state`
- מטא־דאטה של פרויקט / פרופיל / headers / billing

`full_user_state` כולל:

- `requestText`
- `messageWithAttachments`
- `filesForChat`
- `convertedTexts`
- קבצים שהורדו מדרייב או מהוובהוק והוכנו לצ'אט

כאשר `full_user_state` קיים, הוא מקור האמת.
`user_input` נשאר fallback תאימות בלבד.

עוגנים:

- [full-user-state.js](/root/projects/bina-cshera/MAKE2/unified/shared/full-user-state.js)
- [bakar/main.js](/root/projects/bina-cshera/MAKE2/unified/core/bakar/main.js)
- [code/main.js](/root/projects/bina-cshera/MAKE2/unified/core/code/main.js)

### 1.3 מזהה שיחה

במסלול החי, סוכן הקוד דורש `threadId` ציבורי תקין בן 6 תווים.
אין יותר fallback רגיל ל־`X...` במסלול הפעיל של הקוד.

החוק עכשיו:

- `bakar` — `${threadId}bakar`
- `spec` — `${threadId}spec`
- `code` — `threadId`

אם `threadId` חסר או לא תקין, סוכן הקוד נכשל במפורש.

עוגן:

- [main.js](/root/projects/bina-cshera/MAKE2/unified/core/code/main.js)

### 1.4 architect + agent

שלב הארכיטקט ושלב הסוכן הראשי כבר רצים על **אותה** שיחת Gemini:

- `conversation_id = threadId`
- אין יותר `${threadId}archi`
- אין מחיקה
- אין שיחה נפרדת

הסדר:

1. architect prompt
2. agent prompt + tools

שניהם על אותו `conversation_id`.

### 1.5 native tool calling

המסלול הראשי של סוכן הקוד הוא עכשיו `native tool calling`.

המצב החי:

- אין תלות תפעולית רגילה ב־JSON contract
- `ask_user` ו־`finish_task` הם singleton
- שאר הכלים יכולים לחזור כחבילת multi-tool
- ה־runtime מריץ bundle ואז מחזיר continuation רגיל לאותו thread

ברירת המחדל היום היא **ללא** fallback ל־legacy JSON.
ה־fallback נשאר רק אם מישהו מפעיל אותו מפורשות בסביבה.

### 1.5.1 חוזה הכלים החי

ברמת `רגיל` הכלים המותרים הם:

- `communication / ask_user`
- `communication / finish_task`
- `delegation / call_code_worker`
- `source_control / get_file_tree`
- `source_control / list_files`
- `source_control / get_project_structure`
- `source_control / read_file`
- `code_intelligence / get_file_outline`
- `code_intelligence / extract_code_element`
- `code_intelligence / search_code`
- `code_intelligence / find_references`
- `code_intelligence / get_dependents`
- `code_intelligence / check_project_size`
- `code_intelligence / lint_file`
- `code_intelligence / lint_code`
- `code_intelligence / lint_project`
- `code_intelligence / quick_syntax_check`
- `code_intelligence / find_bugs`

ברמת `פרימיום` נוספים:

- `delegation / call_researcher`
- `skills / read_skill`
- `dev_ops / run_terminal_command`
- `dev_ops / run_heavy_cloud_task`
- `dev_ops / build_docker_artifact`

הערה חשובה:

- `list_files` הוא חלק רשמי מחוזה `רגיל`
- אם הוא נדחה בזמן ריצה, זה פער בין חוזה לבין runtime, לא התנהגות מכוונת

### 1.6 prepare-next / clone

במסלול החי של סוכן הקוד:

- אין `prepare-next` מהבקר
- אין `clone` מהבקר
- אין `prepare-next` פנימי של הסוכן אחרי תוצאות כלים

תוצאת כלי או bundle נכנסת חזרה לסוכן כ־`chat` רגיל נוסף על אותו `threadId`.

### 1.7 BINA.MD

`BINA.MD` קיים כחלק מארכיטקטורת העבודה:

- נוצר בתחילת פרויקט חדש
- נטען בתחילת סשן
- נשאר בשורש הריפו
- רק הסוכן אמור לעדכן אותו

### 1.8 סקילים

סקילים קיימים רק במסלול פרימיום:

- בתחילת סשן נטען אינדקס סקילים דינאמי
- הסוכן יכול לקרוא `skills / read_skill`
- תוכן הסקיל חוזר אליו כחלק מאותה שיחה

### 1.8.1 הפועל

מסלול `call_code_worker` עדיין פעיל בשני ה־tiers.

המצב החי כרגע:

- פרומפט ה־worker מגיע מעמודה `O`
- `requestedWorkerModel` נקרא מה־params
- `MODEL_A` נשאר מודל Gemini של ה־tier כפי שהוא מוגדר בפרומפטי הקוד
- `MODEL_B`:
  - ברגיל: `claude-haiku-4-5`
  - בפרימיום: `claude-sonnet-4-5`
- `MODEL_C`:
  - ברגיל: `gpt-5.4-mini`
  - בפרימיום: `gpt-5.4`
- `MODEL_B` ו־`MODEL_C` נפתרים מתוך גליון `מודלים` ב־APP-DATA
- הקריאה עצמה ל־Gemini של worker נשלחת עם המודל שנפתר בפועל

כלומר:

- יש prompt worker יחיד
- ויש עכשיו שלוש בחירות מודל אמיתיות לפועל
- מודל worker מפורש שלא נמצא בקטלוג `מודלים` לא אמור להפיל את הריצה; הוא חוזר כסוג כשל כלי רגיל לסוכן

### 1.9 batch tools

החזית של סוכן הקוד כבר לא אמורה לעודד כלי batch ככלי העבודה הראשי.

במצב החי אחרי הסבב הזה:

- `batch_smart_apply` הוסר מרשימת הכלים החשופה לסוכן
- הפרומפטים עודכנו לעודד כמה קריאות כלי רגילות, לא כלי batch

תמיכה backend ב־`batch_smart_apply` עדיין קיימת בשירותים הפנימיים, אבל היא **לא** חלק מארסנל העבודה התקין של הסוכן.

### 1.10 חוזה ה־toolkit להצגת ריצת קוד

ה־payload היחיד שמותר למסלול הקוד לייצא ל־toolkit לצורכי רינדור והצגה ללקוח הוא:

- מערך JSON של אובייקטים מסוג `actor_iteration`

מקור האמת של החוזה:

- [code-actor-iterations-contract.js](/root/projects/bina-cshera/MAKE2/unified/shared/code-actor-iterations-contract.js)

השדות המחייבים בכל איטרציה:

- `kind`
  - תמיד `"actor_iteration"`
- `actor`
  - `"agent"` או `"worker"`
- `group_id`
  - מזהה פעולה יציב
- `display_title`
  - כותרת אנושית ל־UI
- `thought`
  - מחשבת עבודה קצרה
- `plan`
  - טקסט חופשי או checklist
- `command`
  - קיים רק אם יש פעולת כלי מפורשת
- `blocks`
  - מה הוצע / נוצר / הוכן
- `result_blocks`
  - מה קרה בפועל
- `raw_creative_content`
  - audit מלא של worker output כשצריך

אסור להעביר ל־toolkit במסלול הקוד:

- secondary history raw events
- callback blobs לא מנורמלים
- internal Gemini turns כמו שהם
- tool result payloads חופשיים

כל אלה חייבים לעבור קודם המרה לחוזה `actor_iteration`.

---

## 2. שער התקינות: מצב חי

### 2.1 מה שער התקינות עושה

כאשר הסוכן מחזיר `finish_task`, runtime מריץ:

- `code_intelligence / lint_project`

דרך Service A על הריפו של הפרויקט.

### 2.2 מה הוא **לא** עושה

- הוא לא פותח שיחת Gemini נפרדת
- הוא לא מחליף פרומפט מערכת
- הוא לא משתמש ב־gate prompt ייעודי בתוך שיחה נפרדת

### 2.3 מה קורה אם נמצאו שגיאות

runtime בונה הודעת continuation רגילה לאותה שיחת סוכן:

- סיכום קצר של הלינט
- דוגמאות לשגיאות חוסמות
- הנחיה:
  - או לתקן
  - או להחזיר שוב `finish_task` עם `override_validation_gate=true`

כלומר מבחינת Gemini זו פשוט עוד איטרציה רגילה של הסוכן, עם:

- אותו `conversation_id`
- אותו agent prompt
- אותם tools
- אותם skills אם זה פרימיום

### 2.4 במה הוא כן משתמש server-side

שער התקינות עדיין משתמש ב־`secondary history` בצד השרת לצרכים פנימיים:

- זיהוי `touchedPaths`
- סגירת איטרציות
- בניית דוח ביצוע

אבל:

- זה לא מוזן כזיכרון למודל
- זה לא מקור ההיסטוריה של Gemini
- זה לא מחליף את שיחת הסוכן

### 2.5 כשלי כלי לעומת כשלי מערכת

הכיוון העסקי שננעל:

- כשל כלי צפוי לא אמור להפיל run
- הוא אמור לחזור כסוג של continuation רגיל לסוכן
- כשל מערכת אמיתי שאי אפשר להתאושש ממנו אמור לעבור ל־`failure-handler`

במימוש החי אחרי הסבב האחרון:

- worker / researcher / skill failures כבר מנורמלים ל־continuation רגיל כשיש source record
- כשל ראשי של flow עדיין מדווח גם ל־`failure-handler`

---

## 3. מה נשאר עוד לא מושלם

### 3.1 לוגיקת finish/report עדיין כבדה

שכבת דוח הלקוח עדיין נשענת על event aggregation עשירה, ולא כל הפשטה UX כבר נסגרה.

### 3.2 לינט

הלינט כבר מופעל כחסם אמיתי לפני מסירה, אבל הוא עדיין לא "סופי" מבחינת איכות rule-sets לכל השפות.

הכיוון שננעל:

- JS/TS: ESLint
- Python: Ruff first, Flake8 fallback
- Syntax / pattern / AST checks נוספים
- Project-level:
  - `bandit` כאשר יש Python
  - `mypy` כאשר יש קונפיג מפורש לפרויקט
  - `tsc --noEmit` כאשר יש `tsconfig`

### 3.3 worker prompts legacy

עמודות worker הישנות עדיין קיימות ב־APP-DATA ובמיפוי, וחלקן משמשות למסלולים פנימיים, אבל הן כבר לא מתארות את לולאת הסוכן הראשית.

---

## 4. תכנון היעד הלאה

זה כבר לא “מה יש לעשות כדי לנקות clone/prepare-next”. זה כמעט נסגר.
מה שנשאר קדימה הוא שיפור kernel, לא החלפת bus.

### 4.1 kernel חכם יותר

- שיפור event model
- שיפור ריכוז context
- שיפור workflow של מסירה ודוח לקוח

### 4.2 סקילים בפרימיום

- להרחיב קטלוג סקילים דינאמי
- לחזק בחירה מושכלת של סקיל
- לשפר את ה־UX של טעינת סקיל ותיעוד השימוש בו

### 4.3 lint / verification

- לחזק עוד את lint per language
- לבנות סט בדיקות יותר עמוק למסלולי finish
- להקשיח כללים לפי stack אם צריך

### 4.4 observability

- דוחות ריצה מדויקים יותר
- פחות רעש
- tracing ברור של multi-tool bundles ושל החלטות finish / override

---

## 5. שורה תחתונה

נכון לעכשיו סוכן הקוד כבר עבר את המהפך הארכיטקטוני החשוב:

- `FullUserState`
- `threadId` נקי
- architect + agent באותה שיחה
- native tools
- multi-tool
- בלי `clone`
- בלי `prepare-next`
- שער תקינות כאיטרציה רגילה

מה שנשאר הוא לא “לנקות את הבסיס”, אלא להקשיח וללטש את ה־kernel לרמה של מוצר קודקסי יציב יותר.
