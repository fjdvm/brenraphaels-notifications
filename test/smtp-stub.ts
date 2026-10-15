export interface SmtpCall {
  options: any;
  email: any;
}

export const smtp = {
  calls: [] as SmtpCall[],
  failure: undefined as Error | undefined,
  reset() {
    this.calls = [];
    this.failure = undefined;
  },
};

/** Stands in for `WorkerMailer.send`: records the call, or fails on demand. */
export async function send(options: any, email: any) {
  smtp.calls.push({ options, email });
  if (smtp.failure) throw smtp.failure;
}
