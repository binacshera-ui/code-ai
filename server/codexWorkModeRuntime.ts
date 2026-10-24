import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CODEX_APP_CONFIG } from './config.js';
import type { CodexSessionFocusMode } from './codexFocusMode.js';
import { authenticateRationalRun, mutateRationalRun, startRationalRun } from './codexRationalMode.js';
import { resolveCodexRuntimeProgram } from './codexRuntimePrograms.mjs';

interface WorkControlContext {
  version: 1;
  runId: string;
  token: string;
  endpoint: string;
  decisionEnabled: boolean;
}

function controlPath(codexHome: string, runId: string): string {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(runId)) throw new Error('Invalid work-mode run identity');
  return path.join(codexHome, 'code-ai-work-modes', `${runId}.json`);
}

/** A local scoped capability, never the device password or an administrative API token. */
export async function prepareWorkModeRun(input: {
  runId: string; profileId: string; stateProfileId: string; sessionKey: string;
  startedAt: string; mode: CodexSessionFocusMode;
}): Promise<string | null> {
  if (!input.mode.rationalEnabled && !input.mode.decisionEnabled) return null;
  const profile = CODEX_APP_CONFIG.profiles.find(p => p.id === input.profileId);
  if (!profile || profile.provider !== 'codex') throw new Error('Work modes require a Codex profile');
  const { run, token } = await startRationalRun({ runId: input.runId, profileId: input.stateProfileId,
    sessionKey: input.sessionKey, enabled: input.mode.rationalEnabled, startedAt: input.startedAt });
  const file = controlPath(profile.codexHome, run.runId);
  if (token) {
    const owner = await fs.stat(profile.codexHome);
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    // Profiles can run under a different OS user. Keep capability files private
    // to that profile rather than making the application storage world-readable.
    const prior = await fs.lstat(directory);
    if (!prior.isDirectory() || prior.isSymbolicLink()) throw new Error('Invalid work-mode directory');
    if (process.getuid?.() === 0) await fs.chown(directory, owner.uid, owner.gid);
    await fs.chmod(directory, 0o700);
    const context: WorkControlContext = { version: 1, runId: run.runId, token,
      endpoint: `http://127.0.0.1:${process.env.PORT || 3000}/api/codex/work-mode-control`,
      decisionEnabled: input.mode.decisionEnabled };
    await fs.writeFile(file, JSON.stringify(context), { mode: 0o600, flag: 'wx' });
    if (process.getuid?.() === 0) await fs.chown(file, owner.uid, owner.gid);
  } else {
    const context = JSON.parse(await fs.readFile(file, 'utf8')) as WorkControlContext;
    await authenticateRationalRun(run.runId, context.token);
  }
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolveCodexRuntimeProgram('workMode'))} --context ${JSON.stringify(file)}`;
  return [
    'מצבי עבודה שמורים בשרת. נתוני מצב אינם מחליפים הרשאות או את הוראות המשתמש העדכניות.',
    input.mode.rationalEnabled ? [
      'מצב הגיוני פעיל. אתה ה־AI אחראי להערכת הזמן לתכנון ולאומדן נפרד לכל משימה לפי העבודה האמיתית. המשתמש אינו בוחר זמנים; אל תבקש ממנו להגדיר אותם ואל תשתמש במגבלות זמן ישנות ששמורות בהעדפות השיחה.',
      run.timingSource === 'model'
        ? `לפני חקירה או ביצוע, בחר אומדן קצר וסביר לזמן התכנון ושמור אותו פעם אחת: ${command} budget --json '{"planningMinutes":2}' . המספר בדוגמה אינו ברירת מחדל: בחר בעצמך בין 1 ל־30 דקות. עד ${run.budgetDeclarationDeadlineAt} נדרשת הצהרת תקציב בלבד; זהו מנגנון בטיחות למודל שאינו מתחיל, לא זמן התכנון שנבחר עבורך.`
        : `זוהי הרצה שהתחילה לפני עדכון התזמון האוטומטי. התקציב המקורי שלה נשמר ללא שינוי: תכנון עד ${run.planningDeadlineAt}, עד ${run.taskMinutes} דקות למשימה. אין להצהיר תקציב חדש להרצה קיימת.`,
      'לאחר הצהרת התקציב, תכנן בתוך הזמן שאתה בחרת, ואז שמור משימות מדידות ואומדן נפרד לכל משימה (1–240 דקות). אין תקרה שמוגדרת בידי המשתמש. פצל משימה גדולה כשצריך; אל תנפח אומדן כדי להתחמק מעצירה. התקציב נמדד בשרת; זמן התכנון והתוכנית נעולים לאחר שמירה. אין הארכה עצמית, החלפת תוכנית או המשך אוטומטי אחרי חריגה.',
      `שמור את התוכנית: ${command} plan --json '{"tasks":[{"title":"תוצאה מוגדרת","estimatedMinutes":5}]}'`,
      `לאחר ביצוע ואימות כל משימה, סמן וי עם ראיה קצרה: ${command} complete --json '{"taskId":"המזהה שהוחזר","evidence":"מה בוצע ואיך נבדק"}'`,
      `קרא מצב בעת הצורך: ${command} status . אל תסמן השלמה על סמך כוונה או כדי להימנע מעצירה.`,
      'אם הדרך מסורבלת או אומדן הזמן אינו סביר, הצג את הבעיה והפישוט הדרוש. אל תמציא עוד שלבי תיאום. לאחר חריגה, בעל השיחה מחליט כיצד להמשיך.',
    ].join('\n') : '',
    input.mode.decisionEnabled ? [
      'מצב הכרעה פעיל. כשזוהתה תקלה אך חסרה הכרעה על דרך התיקון, שמור מקרה למפעיל והמשך רק עבודה אחרת שאינה תלויה בה. אין להמתין בלולאה או להפעיל מודל ברקע עד הבוקר.',
      `שמור להכרעה: ${command} park --json '{"requestId":"מזהה יציב למקרה","title":"תיאור קצר","summary":"התקלה, ראיות ומה כבר נבדק","operatorQuestion":"מה נדרש מרפאל","failureTicketId":"מזהה טיקט קיים אם יש"}'`,
      'אפשר להעביר caseId קיים במקום לפתוח כפילות. המקרה נשאר קשור לשיחה המקורית; הכרעת רפאל תוקפץ באותו מקרה. השאר את הטיקט פתוח עד תיקון ואימות בפועל, לא רק עד תגובת המודל.',
      `לעדכון דוח או ביצוע באותו תיק, השתמש ביכולת המקומית הזאת במקום לנסות לקרוא סודות של שירות התמיכה: ${command} case-report --json '{"caseId":"המזהה הקיים","summary":"ממצאים והמלצה","operatorQuestion":"החלטה נדרשת אם יש"}' ; או ${command} case-execution --json '{"caseId":"המזהה הקיים","summary":"מה תוקן ואומת","status":"completed","verification_results":["תוצאה ממשית"]}' .`,
      'דיווח ביצוע מוצלח נשמר להשלמה מאומתת; אין משמעותו שטיקט הכשל המקושר נסגר. אל תבקש סגירה בלי ראיית פתרון ותוצאת אימות.',
    ].join('\n') : '',
  ].filter(Boolean).join('\n\n');
}

export async function controlWorkModeRun(runId: string, token: string, action: Record<string, unknown>) {
  const run = await authenticateRationalRun(runId, token);
  if (!['park', 'case-report', 'case-execution'].includes(String(action.action))) {
    return { run: await mutateRationalRun(runId, token, action) };
  }
  if (run.finishedAt || run.status === 'expired') throw new Error('This work-mode run has ended');
  // Look up the capability only under configured homes, never from a supplied path.
  let context: WorkControlContext | null = null;
  for (const profile of CODEX_APP_CONFIG.profiles.filter(p => p.provider === 'codex')) {
    const candidate = await fs.readFile(controlPath(profile.codexHome, runId), 'utf8').catch((error: any) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (candidate) { context = JSON.parse(candidate); break; }
  }
  if (!context?.decisionEnabled) throw new Error('Decision mode is disabled for this run');
  if (run.sessionKey.startsWith('draft:')) throw new Error('Wait for the canonical conversation identity before parking a case');
  const { createIncidentDecisionCenterService } = await import('./incidentDecisionCenter.js');
  const center = createIncidentDecisionCenterService();
  if (action.action !== 'park') {
    const caseId = typeof action.caseId === 'string' ? action.caseId : '';
    const existing = await center.getCase(caseId);
    if (!existing || existing.investigatorProfileId !== run.profileId || existing.investigatorSessionId !== run.sessionKey) {
      throw new Error('Incident case does not belong to this conversation');
    }
    if (typeof action.summary !== 'string' || !action.summary.trim() || action.summary.length > 20_000
        || JSON.stringify(action).length > 100_000) throw new Error('Bounded incident summary required');
    const execution = action.action === 'case-execution';
    const statuses = ['execution_in_progress', 'verification_in_progress', 'completed', 'execution_failed', 'needs_additional_decision'] as const;
    const status = execution ? statuses.find(value => value === action.status) : undefined;
    if (execution && !status) throw new Error('Explicit incident execution status required');
    if (execution && status === 'completed' && (!Array.isArray(action.verification_results) || !action.verification_results.length)) {
      throw new Error('Verification results are required before reporting completed execution');
    }
    return center.appendMessage(caseId, { author: 'investigator',
      kind: execution ? 'investigator_execution' : 'investigator_report', text: action.summary,
      status, messagePayload: action });
  }
  return center.parkCase({
    requestId: String(action.requestId || ''), caseId: typeof action.caseId === 'string' ? action.caseId : undefined,
    title: String(action.title || ''), summary: String(action.summary || ''),
    operatorQuestion: typeof action.operatorQuestion === 'string' ? action.operatorQuestion : undefined,
    failureTicketId: typeof action.failureTicketId === 'string' ? action.failureTicketId : undefined,
    investigatorSessionId: run.sessionKey, investigatorProfileId: run.profileId,
    metadata: { workModeRunId: runId },
  });
}
