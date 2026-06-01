export type KeelErrorCode =
  | "agent_missing_stop"
  | "provider_auth_failed"
  | "provider_rate_limited"
  | "provider_server_error"
  | "provider_http_error";

export class KeelError extends Error {
  readonly code: KeelErrorCode;

  constructor(code: KeelErrorCode, message: string) {
    super(message);
    this.name = "KeelError";
    this.code = code;
  }
}
