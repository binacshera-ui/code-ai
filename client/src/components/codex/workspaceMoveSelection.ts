export interface WorkspaceMoveSelectableSession {
  id: string;
  cwd: string | null;
  topic?: {
    id: string;
    cwd: string;
  } | null;
}

export function buildWorkspaceMovePlan(input: {
  sessions: WorkspaceMoveSelectableSession[];
  selectedSessionIds: string[];
  selectedTopicIds: string[];
  successfullyMovedTopicIds: Iterable<string>;
  targetCwd: string;
}): {
  topicIds: string[];
  sessionIds: string[];
} {
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
  const topicsById = new Map(
    input.sessions
      .filter((session) => Boolean(session.topic))
      .map((session) => [session.topic!.id, session.topic!]),
  );
  const movedTopicIds = new Set(input.successfullyMovedTopicIds);
  const topicIds = [...new Set(input.selectedTopicIds)]
    .filter((topicId) => topicsById.get(topicId)?.cwd !== input.targetCwd);
  const sessionIds = [...new Set(input.selectedSessionIds)]
    .filter((sessionId) => {
      const session = sessionsById.get(sessionId);
      return Boolean(
        session
        && session.cwd !== input.targetCwd
        && (!session.topic || !movedTopicIds.has(session.topic.id))
      );
    });

  return { topicIds, sessionIds };
}
