import {
  isRefusalRule,
  refusalSentences,
  type RefusalRule,
} from "../../src/sharing-refusals";

/** There is no Memtrace sign-in to show. The person has to sign in. */
export class SharingSignedOut extends Error {
  constructor(message = "Sign in to Memtrace to see the projects you share.") {
    super(message);
    this.name = "SharingSignedOut";
  }
}

/** Sharing cannot be used right now. The message says what the person can do. */
export class SharingUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SharingUnavailable";
  }
}

/** One of the sharing service's rules turned the request down. The message is MemCode's sentence for it. */
export class SharingRefused extends Error {
  constructor(readonly rule: RefusalRule) {
    super(refusalSentences[rule]);
    this.name = "SharingRefused";
  }
}

/** The refusal for a rule name the service sent, or nothing for a name MemCode does not know. */
export const refusalNamed = (rule: string | undefined) =>
  rule !== undefined && isRefusalRule(rule)
    ? new SharingRefused(rule)
    : undefined;
