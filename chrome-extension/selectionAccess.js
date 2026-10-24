// A focus shared explicitly by UUID may be read by another conversation on the
// same CODE-AI server/profile. Its UUID alone never grants write access.
export function sameSelectionPrincipal(selectionSession, commandSession) {
  return Boolean(selectionSession && commandSession
    && selectionSession.serverId === commandSession.serverId
    && selectionSession.profileId === commandSession.profileId);
}

export function sameSelectionSession(selectionSession, commandSession) {
  return sameSelectionPrincipal(selectionSession, commandSession)
    && selectionSession.sessionKey === commandSession.sessionKey
    && selectionSession.bindingId === commandSession.bindingId;
}

export function mayReadSelection(selection, commandSession, requestedIds) {
  if (!selection || !sameSelectionPrincipal(selection.session, commandSession)) return false;
  return sameSelectionSession(selection.session, commandSession)
    || (requestedIds instanceof Set && requestedIds.has(selection.selectionId));
}

export function selectionPageChanged(capturedUrl, currentUrl) {
  if (!capturedUrl || !currentUrl) return true;
  try {
    const captured = new URL(capturedUrl);
    const current = new URL(currentUrl);
    return captured.origin !== current.origin
      || captured.pathname !== current.pathname
      || captured.search !== current.search
      || captured.hash !== current.hash;
  } catch {
    return capturedUrl !== currentUrl;
  }
}
