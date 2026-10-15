import { describe, expect, it } from 'vitest';
import {
  PermanentFailure,
  classifyFailure,
  retryDelaySeconds,
} from '../src/emails/retry';

describe('retryDelaySeconds', () => {
  it('grows and then caps at one hour', () => {
    const delays = [1, 2, 3, 4, 8, 20].map(retryDelaySeconds);
    expect(delays).toEqual([30, 60, 120, 240, 3600, 3600]);
  });
});

describe('classifyFailure', () => {
  const kind = (m: string | Error) =>
    classifyFailure(typeof m === 'string' ? new Error(m) : m).kind;

  it.each([
    'Timeout while waiting for smtp server response',
    'Socket timeout!',
    'Failed to EHLO. 421 service not available',
    'Invalid RCPT TO: <a@b.c> 450 mailbox busy',
    'Failed to plain authentication: 535 bad credentials',
    'WorkerMailer is shutting down',
  ])('treats "%s" as temporary', (m) => expect(kind(m)).toBe('temporary'));

  it.each([
    'Invalid RCPT TO: <nobody@b.c> 550 no such user',
    'Failed send email body: 554 content rejected',
    'Invalid MAIL FROM: <x@y.z> 553 sender blocked',
  ])('treats "%s" as permanent', (m) => expect(kind(m)).toBe('permanent'));

  it('treats a PermanentFailure as permanent and keeps its reason', () => {
    expect(classifyFailure(new PermanentFailure('Unknown template x'))).toEqual(
      { kind: 'permanent', reason: 'Unknown template x' },
    );
  });
});
