export interface SmtpCall {
  options: any;
  email: any;
}

export const smtp = {
  calls: [] as SmtpCall[],
  /** Fails every send until cleared. */
  failure: undefined as Error | undefined,
  /** One entry per upcoming send; when empty, sends succeed. */
  script: [] as Array<'ok' | 'hang' | Error | { acceptedThen: Error }>,
  /** Runs inside each send, before the outcome is decided. */
  onSend: undefined as undefined | (() => Promise<void>),
  reset() {
    this.calls = [];
    this.failure = undefined;
    this.script = [];
    this.onSend = undefined;
  },
};

/** Stands in for `WorkerMailer.send`: records the call, or fails on demand. */
export async function send(options: any, email: any) {
  smtp.calls.push({ options, email });
  await smtp.onSend?.();
  if (smtp.failure) throw smtp.failure;
  const step = smtp.script.shift() ?? 'ok';
  if (step === 'hang') return new Promise<void>(() => {});
  if (step === 'ok') return;
  if (step instanceof Error) throw step;
  throw step.acceptedThen;
}
