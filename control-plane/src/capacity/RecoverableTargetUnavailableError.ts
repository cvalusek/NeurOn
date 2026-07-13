export class RecoverableTargetUnavailableError extends Error {
  readonly code = "RECOVERABLE_TARGET_UNAVAILABLE" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecoverableTargetUnavailableError";
  }
}
