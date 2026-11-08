/** An Email that is still failing temporarily this long after queueing is given up on. */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

const BASE_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 60 * 60;

/** Delay before retrying after `attempts` failed attempts: 30s, 60s, 2m ... capped at 1h. */
export function retryDelaySeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(BASE_DELAY_SECONDS * 2 ** exponent, MAX_DELAY_SECONDS);
}

export class PermanentFailure extends Error {}

export interface Failure {
  kind: 'temporary' | 'permanent';
  reason: string;
}

// Credential problems are ours to fix, so the Email should survive until we do.
const TEMPORARY_5XX = new Set([530, 534, 535]);

/**
 * Sorts a Node SMTP error by its structured reply code, falling back to reply
 * text. No reply (timeout or dropped socket) is temporary.
 */
export function classifyFailure(err: unknown): Failure {
  const reason = err instanceof Error ? err.message : String(err);
  if (err instanceof PermanentFailure) return { kind: 'permanent', reason };
  const responseCode =
    err instanceof Error &&
    'responseCode' in err &&
    typeof err.responseCode === 'number'
      ? String(err.responseCode)
      : undefined;
  const code =
    responseCode ??
    /(?:^|\s)([45]\d{2})(?:-|\s(?!\s*(?:ms|s|sec|seconds|bytes)\b)|$)/.exec(
      reason,
    )?.[1];
  if (code?.startsWith('5') && !TEMPORARY_5XX.has(Number(code)))
    return { kind: 'permanent', reason };
  return { kind: 'temporary', reason };
}
