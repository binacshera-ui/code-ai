import { normalizeProfileIdentity } from './profileIdentity.js';

export function profileRevision(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function sameProfile(left, right) {
  return JSON.stringify(normalizeProfileIdentity(left)) === JSON.stringify(normalizeProfileIdentity(right));
}

export function profileSnapshot(identity, revision = 0) {
  return { profileIdentity: normalizeProfileIdentity(identity), profileRevision: profileRevision(revision) };
}

/** An explicit edit uses compare-and-swap; a stale editor never wins silently. */
export function updateProfile(current, input) {
  const previous = profileSnapshot(current.profileIdentity, current.profileRevision);
  if (!Number.isSafeInteger(input?.baseRevision) || input.baseRevision < 0) {
    throw Object.assign(new Error('נדרשת גרסת הפרופיל לפני שמירה.'), { code: 'PROFILE_REVISION_REQUIRED' });
  }
  if (input.baseRevision !== previous.profileRevision) {
    throw Object.assign(new Error('הפרופיל השתנה במקום אחר. הפרטים שערכת נשמרו; בדוק ושמור שוב.'), { code: 'PROFILE_CONFLICT' });
  }
  const next = normalizeProfileIdentity(input.profileIdentity);
  if (!next.name) throw Object.assign(new Error('יש להזין שם לפרופיל.'), { code: 'INVALID_PROFILE' });
  if (input.profileIdentity?.avatarDataUrl && !next.avatarDataUrl) {
    throw Object.assign(new Error('תמונת הפרופיל אינה תקינה או גדולה מדי.'), { code: 'INVALID_PROFILE' });
  }
  return sameProfile(previous.profileIdentity, next) ? previous : profileSnapshot(next, previous.profileRevision + 1);
}

/** Old installations may bootstrap a missing profile, never erase a saved one. */
export function adoptInitialProfile(current, incoming) {
  const previous = profileSnapshot(current.profileIdentity, current.profileRevision);
  const local = normalizeProfileIdentity(incoming);
  return !previous.profileIdentity.name && previous.profileRevision === 0 && local.name
    ? profileSnapshot(local, 1) : previous;
}

/** Retain an offline draft while receiving the server's canonical revision. */
export function receiveProfile(current, incoming) {
  const snapshot = profileSnapshot(incoming.profileIdentity, incoming.profileRevision);
  if (snapshot.profileRevision < profileRevision(current.profileRevision)) return current;
  const pending = current.pendingIdentity ? normalizeProfileIdentity(current.pendingIdentity) : null;
  if (!pending || sameProfile(pending, snapshot.profileIdentity)) {
    return { ...snapshot, pendingIdentity: null, conflict: false };
  }
  return { ...snapshot, pendingIdentity: pending,
    conflict: current.conflict === true || snapshot.profileRevision > profileRevision(current.profileRevision) };
}
