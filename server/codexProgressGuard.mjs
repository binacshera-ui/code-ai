import { createHash } from 'node:crypto';

export const CODEX_PROGRESS_GUARD_INSTRUCTION = [
  'מיקוד וביצוע: זוהתה חזרה על אותה פקודה שנכשלה עם אותה תוצאה בתוך התור הנוכחי.',
  'בדוק מה כבר הוכח ומהו יעד המשתמש העדכני. אל תחזור שוב על אותו ניסיון בלי מידע חדש.',
  'בחן קודם אם דרך העבודה עצמה מסורבלת או פגומה. אם כן, אמור לרפאל מה הבעיה והצע מה להסיר או לאחד ומסלול פשוט יותר; אל תוסיף עוד שלב או תיאום כדי להציל תוכנית לא טובה.',
  'בצע פישוט רגיל בתוך ההיקף המאושר; אם נדרש שינוי מהותי או סמכות נוספת, הצג החלטה קונקרטית אחת והפסק את הניסיונות המיותרים.',
  'זו הנחיית חשיבה ביקורתית בתוך התור הקיים: לא משימת משתמש חדשה, לא ביטול עבודה ולא הרשאה נוספת.',
  'שמור על הוראות המערכת, המפתח והמשתמש, הרשאות, בטיחות, בעלות הסשן ושערי בקרת הפריסה המחייבים; אל תסיר נעילות, אל תיצור כותב נוסף ואל תשלח שוב קלט שקבלתו אינה מוכרעת.',
].join('\n');

const MAX_COMMANDS = 256;
const MAX_COMPLETED_ITEMS = 1_024;

function digest(parts) {
  const hash = createHash('sha256');
  for (const part of parts) {
    const text = String(part);
    hash.update(String(Buffer.byteLength(text)));
    hash.update(':');
    hash.update(text);
  }
  return hash.digest('hex');
}

function setBounded(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

/**
 * Conservative, per-native-turn observer. The caller must pass only an owned
 * parent item/completed event, not replayed history or child-agent events, and
 * must durably claim any intervention across reconnects before steering.
 * Nothing here executes a command, sends input, cancels work, or retains raw
 * commands/output. A new instance starts a new in-memory observation window.
 */
export function createCodexProgressGuard({ threshold = 3, maxInterventions = 1 } = {}) {
  const boundedThreshold = Number.isFinite(threshold) ? Math.min(10, Math.max(2, Math.trunc(threshold))) : 3;
  const interventionLimit = Number.isFinite(maxInterventions) && maxInterventions <= 0 ? 0 : 1;
  const failuresByCommand = new Map();
  const completedItems = new Map();
  let interventions = 0;

  return {
    observeItem(item) {
      if (!item || typeof item !== 'object' || item.type !== 'commandExecution') return null;
      if (item.status !== 'completed' && item.status !== 'failed') return null;
      if (typeof item.id !== 'string' || !item.id || typeof item.command !== 'string' || !item.command.trim()) return null;
      const itemKey = digest([item.id]);
      if (completedItems.has(itemKey)) return null;
      setBounded(completedItems, itemKey, true, MAX_COMPLETED_ITEMS);

      const commandKey = digest([typeof item.cwd === 'string' ? item.cwd : '', item.command]);
      const exitCode = typeof item.exitCode === 'number' && Number.isFinite(item.exitCode) ? item.exitCode : null;
      const failed = item.status === 'failed' || (exitCode !== null && exitCode !== 0);
      if (!failed) {
        // Successful polling/waiting is not evidence of a loop. A successful
        // retry also breaks this command's prior failure streak.
        failuresByCommand.delete(commandKey);
        return null;
      }
      const resultKey = digest([item.status, exitCode, typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '']);
      const previous = failuresByCommand.get(commandKey);
      const count = previous?.resultKey === resultKey ? Math.min(boundedThreshold, previous.count + 1) : 1;
      setBounded(failuresByCommand, commandKey, { resultKey, count }, MAX_COMMANDS);
      if (count < boundedThreshold || interventions >= interventionLimit) return null;
      interventions += 1;
      return {
        kind: 'repeated_failure',
        fingerprint: digest([commandKey, resultKey]),
        count,
        instruction: CODEX_PROGRESS_GUARD_INSTRUCTION,
      };
    },
  };
}
