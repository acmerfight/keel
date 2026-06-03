export type KeelErrorCode =
  | "agent_missing_stop"
  | "agent_tool_call_limit_exceeded"
  | "agent_unsupported_tool_calls"
  | "provider_auth_failed"
  | "provider_rate_limited"
  | "provider_server_error"
  | "provider_http_error"
  | "provider_protocol_error"
  | "provider_aborted"
  | "provider_network_error";

export class KeelError extends Error {
  readonly code: KeelErrorCode;

  constructor(code: KeelErrorCode, message: string) {
    super(message);
    this.name = "KeelError";
    this.code = code;
  }
}
