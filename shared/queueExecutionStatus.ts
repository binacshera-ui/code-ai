export function queueExecutionStatus<T extends {status:string;nativeSubmission?:{deliveryPhase?:string;turnId?:string|null}|null}>(item:T):T['status'] {
  const submission = item.nativeSubmission;
  if (item.status === 'running' && submission && !submission.turnId
    && ['prepared','queued','detached'].includes(submission.deliveryPhase || '')) return 'queued';
  return item.status;
}
