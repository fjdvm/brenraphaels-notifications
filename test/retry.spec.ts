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
    'Connection closed',
    'Timed out after 500 ms waiting for the relay',
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

// Nodemailer exposes the reply as responseCode independently of the message text.
describe('Node SMTP replies', () => {
  it.each([
    [421, 'temporary'],
    [450, 'temporary'],
    [550, 'permanent'],
    [554, 'permanent'],
    [530, 'temporary'],
    [534, 'temporary'],
    [535, 'temporary'],
  ])('classifies reply %i as %s', (responseCode, kind) => {
    const error = Object.assign(new Error('Relay rejected the send'), {
      responseCode,
    });
    expect(classifyFailure(error).kind).toBe(kind);
  });
});
