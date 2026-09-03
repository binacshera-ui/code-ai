# מחקר סקילים לפרימיום של Codex בינה כשרה

## מטרת המסמך
לתת לך תמונה קצרה וברורה:
- אילו סקילים כדאי לשקול לפרימיום
- מה כל סקיל נותן בפועל
- על אילו מקורות רשת הוא נשען
- מה כבר הוטמע כרגע דינאמית במערכת

## מה סגור ארכיטקטונית
- סקילים הם **פרימיום בלבד**.
- בתחילת סשן נטען לסוכן רק **אינדקס סקילים מתומצת**.
- אם הנושא קשור לסקיל, הסוכן אמור לקרוא אותו דרך הכלי `skills / read_skill`.
- הסקיל המלא נטען רק לפי שם.
- הסקילים נטענים דינאמית מספריית הקבצים, כך שאפשר להוסיף/להסיר בלי לשנות קוד ליבה.

## סקילים שנבחרו לשלב הראשון

### 1. `nextjs-commerce`
מיועד ל:
- חנויות
- storefront
- checkout
- admin מסחרי
- פרויקטי Next.js App Router

מה הוא מכיל:
- עבודה נכונה עם Server/Client Components
- boundaries למסחר, admin ו-shared UI
- SEO, metadata, caching, loading/error states
- כללי ביצוע שלא יהפכו חנות ל-SPA מבולגן

מקורות:
- Next.js App Router docs
- Next.js production checklist

### 2. `ui-accessibility-polish`
מיועד ל:
- עיצוב מסכים
- polish
- נגישות
- responsive behavior

מה הוא מכיל:
- היררכיה חזותית
- keyboard flow
- semantics
- focus / contrast
- empty / loading / error states

מקורות:
- W3C WCAG quick reference
- Next.js production guidance

### 3. `node-api-production`
מיועד ל:
- Node backend
- Express/Fastify style APIs
- admin backends
- webhooks/services

מה הוא מכיל:
- הפרדת routes / services / repositories
- config loader
- error handling
- validation
- health endpoints

מקורות:
- Node.js official learn docs
- Express guide

### 4. `python-cli-packaging`
מיועד ל:
- כלי CLI
- פרויקטי Python מסודרים
- packaging והפצה

מה הוא מכיל:
- `pyproject.toml`
- entry points
- venv
- structure נכון ל-package
- packaging flow

מקורות:
- Python Packaging User Guide

### 5. `csharp-aspnet-business`
מיועד ל:
- מערכות עסקיות ב-C#
- ASP.NET Core
- MVC / Razor / Web API
- מערכות ניהול ופורטלים

מה הוא מכיל:
- Clean Architecture / layered architecture
- config/environments
- service boundaries
- EF/Core discipline
- auth / validation / health

מקורות:
- Microsoft Learn ASP.NET Core
- .NET architecture guidance

### 6. `csharp-legacy-modernization`
מיועד ל:
- פרויקטי C# ישנים
- .NET Framework
- WinForms / ASP.NET ישן / legacy backends

מה הוא מכיל:
- מודרניזציה מדורגת
- שמירת behavior
- בידוד תלותים
- שיפור buildability לפני rewrite

מקורות:
- Microsoft architecture guidance
- ASP.NET migration/structure material

### 7. `cpp-modernization`
מיועד ל:
- C++
- native code
- ביצועים
- legacy C++

מה הוא מכיל:
- RAII
- modern STL
- ownership discipline
- CMake
- sanitizers
- warning hygiene

מקורות:
- C++ Core Guidelines
- CMake official tutorial

### 8. `vbs-office-automation`
מיועד ל:
- VBS / VBScript / VBA
- Office automation
- COM / WSH
- קוד Windows legacy

מה הוא מכיל:
- WScript/CScript awareness
- COM usage discipline
- file/host safety
- compatibility mindset

מקורות:
- Microsoft Learn על Windows Script Host
- Microsoft Learn על COM objects ב-WSH

### 9. `postgres-schema-migrations`
מיועד ל:
- PostgreSQL
- schema design
- migrations
- indexes / constraints / backfills

מה הוא מכיל:
- סדר בטוח לשינויי schema
- nullable -> backfill -> enforce
- index discipline
- migration clarity

מקורות:
- PostgreSQL docs
- Prisma Postgres operational guidance

### 10. `docker-production-build`
מיועד ל:
- Docker deployment
- build artifacts
- runtime image hardening

מה הוא מכיל:
- multi-stage builds
- small runtime images
- `.dockerignore`
- cache-aware Dockerfiles
- non-root guidance

מקורות:
- Docker build docs
- Dockerfile best practices
- Docker build checks

### 11. `repo-mapping-large-codebase`
מיועד ל:
- ריפו גדול
- כניסה לפרויקט לא מוכר
- הורדת סיכון לפני עריכה

מה הוא מכיל:
- entry points
- structure scanning
- hotspot mapping
- minimal repo map mindset

מקורות:
- Aider repo map docs

## למה בחרתי דווקא את אלה
זו לא רשימה “יפה”, אלא רשימה עסקית:
- חנות / web app / admin
- backend APIs
- Python
- שפות ותיקות וחשובות עסקית: `C#`, `C++`, `VBS`
- DB
- Docker
- כניסה לריפו גדול

כלומר, זו תשתית אמיתית לסוכן פרימיום שעובד על פרויקטים מגוונים ולא רק על web JS מודרני.

## איך זה שונה מ"עוד פרומפט"
כל סקיל הוא:
- מטרה ברורה
- מתי להפעיל
- checklist
- סימני אזהרה
- מקורות

הוא לא מחליף:
- את האיפיון
- את מצב הריפו
- את BINA.MD

הוא כן מוסיף:
- מיומנות ממוקדת לפי תחום

## מה כבר הוטמע בפועל
הספרייה הדינאמית של הסקילים כרגע:
- `MAKE2/unified/core/code/premium-skills/`

הסוכן טוען:
- בתחילת סשן: אינדקס סקילים בלבד
- בזמן העבודה: סקיל מלא דרך `read_skill`

## מקורות מרכזיים
- Gemini function calling: https://ai.google.dev/gemini-api/docs/function-calling
- Gemini thought signatures: https://ai.google.dev/gemini-api/docs/thought-signatures
- Next.js docs: https://nextjs.org/docs
- Next.js production checklist: https://nextjs.org/docs/app/guides/production-checklist
- Docker build docs: https://docs.docker.com/build/
- Dockerfile best practices: https://docs.docker.com/engine/userguide/eng-image/dockerfile_best-practices/
- Docker build checks: https://docs.docker.com/reference/build-checks/
- Python packaging: https://packaging.python.org/
- ASP.NET Core: https://learn.microsoft.com/en-us/aspnet/core/
- .NET web architectures: https://learn.microsoft.com/en-us/dotnet/architecture/modern-web-apps-azure/common-web-application-architectures
- C++ Core Guidelines: https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines
- CMake tutorial: https://cmake.org/cmake/help/latest/guide/tutorial/index.html
- Windows Script Host / COM: https://learn.microsoft.com/en-us/windows/win32/com/using-com-objects-in-windows-script-host
- WScript docs: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/wscript
- Aider repo map: https://aider.chat/docs/repomap.html
