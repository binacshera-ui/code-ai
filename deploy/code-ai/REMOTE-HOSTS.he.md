# חיבור שרתי Codex ומחשבים אישיים ל־code-ai

המערכת בנויה בשתי שכבות:

- `control plane` — שרת ה־code-ai הראשי, שמציג את בורר השרתים ומאמת את המשתמש.
- `remote sidecar` — מופע code-ai קטן שרץ על מחשב היעד ב־loopback בלבד ומפעיל שם את ה־CLI, הקבצים והסשנים האמיתיים.

ה־control plane אינו קורא מרחוק קבצי `.codex` בעצמו. הוא מעביר את אותה בקשת API דרך מנהרה מאומתת אל ה־sidecar. כך אין הבדל פונקציונלי בין חשבון מקומי לחשבון מרוחק, ואין צורך לממש מחדש כל כלי או כל פעולת קובץ.

## שרת עם SSH נכנס

על שרת ה־control plane:

```bash
node scripts/remote-host-deploy.mjs \
  --id build-server \
  --label "Build server" \
  --ssh-target build-server \
  --profiles-json '[{"id":"build-codex","label":"Build Codex","provider":"codex","codexHome":"/home/operator/.codex","workspaceCwd":"/srv/projects","defaultProfile":true}]'
```

הפקודה:

1. בונה את code-ai מקומית.
2. מעתיקה רק את חבילת ה־runtime לשרת המרוחק.
3. מתקינה sidecar כ־systemd service על פורט loopback.
4. מייצרת token אקראי שאינו נכנס ל־Git.
5. מעדכנת את `.code-ai/remote-hosts.json` המקומי בהרשאות `0600`.

## מחשב אישי מאחורי NAT

אין צורך לפתוח פורט בנתב, לערוך firewall או לחשוף את ה־sidecar לאינטרנט.

תחילה מייצרים ב־control plane רישום וקובץ pairing פרטי:

```bash
npm run remote:pair-personal -- \
  --id personal-laptop \
  --label "המחשב האישי" \
  --control-target user@control-plane.example.com \
  --reverse-port 44001 \
  --ssh-reverse-port 44022 \
  --ssh-local-port 22
```

הפקודה מעדכנת אטומית את ה־registry ומייצרת תחת
`.code-ai/pairings/personal-laptop.env` קובץ `0600` עם token אקראי. מעבירים את
הקובץ למחשב האישי בערוץ מאובטח; אין להדביק אותו בצ'אט או להוסיף אותו ל־Git.
הדגלים `--ssh-reverse-port` ו־`--ssh-local-port` אופציונליים: משמיטים אותם
כאשר נדרשת רק גישה ל־code-ai. כאשר הם מוגדרים, אותה מנהרה יוצאת מוסיפה בשרת
הבקרה פורט SSH שנקשר ל־`127.0.0.1` בלבד.

במחשב האישי, מתוך checkout של code-ai:

```bash
npm ci
npm run build
npm run remote:personal-agent -- \
  --pairing-file /secure/path/personal-laptop.env \
  --workspace /path/to/projects
```

ה־agent מפעיל את ה־sidecar על loopback, ממתין לבדיקת health מאומתת, ופותח
`reverse SSH` עם keepalive ו־auto-reconnect. במחשב קבוע מומלץ להריץ את הפקודה
כשירות משתמש (`systemd --user`, ‏LaunchAgent או Task Scheduler). מפתחות ה־SSH
וה־token נשארים מחוץ לריפו ולדפדפן.

כדי להפעיל גם SSH נכנס פרטי, מתקינים במחשב OpenSSH Server ומוסיפים למשתמש
המיועד רק את המפתח הציבורי הייעודי של שרת הבקרה. אין צורך לפתוח פורט בנתב,
וכלל ה־firewall הציבורי של OpenSSH יכול להישאר כבוי. לאחר אימות טביעת מפתח
המחשב, שרת הבקרה מתחבר דרך:

```bash
ssh -p 44022 <computer-user>@127.0.0.1
```

## גבולות אבטחה

- ה־sidecar מאזין רק על `127.0.0.1`.
- כל בקשה דורשת `x-code-ai-remote-token`.
- דפדפן המשתמש אינו מקבל את ה־token; רק שרת ה־control plane מוסיף אותו.
- cookies וזהויות המשתמש אינן מועברות לשרת המרוחק.
- מנהרת SSH משתמשת ב־`BatchMode`, ‏`StrictHostKeyChecking` מהגדרת ה־SSH ו־keepalive.
- ה־registry הפרטי נמצא תחת `.code-ai` ולכן מוחרג מ־Git.
- URL של טריגר לסשן מרוחק כולל מזהה שרת, אך לא כולל את token של המנהרה.
  ה־control plane מעביר רק את endpoint הטריגר המאומת אל ה־sidecar.

## בדיקה ללא פרודקשיין

מריצים מופע staging על פורט אחר וב־storage מבודד:

```bash
PORT=4101 \
CODEX_STORAGE_ROOT=/tmp/code-ai-staging \
CODEX_REMOTE_HOSTS_FILE=/path/to/private/remote-hosts.json \
NODE_ENV=development \
node dist/server.js
```

רק לאחר שבדיקות ה־API, ה־UI והפעלת Codex המרוחקת עוברות, מבצעים restart מתוכנן לתהליך הפרודקשיין.
