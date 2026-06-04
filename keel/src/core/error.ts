export type KeelErrorCode =
  | "agent_missing_stop"
  | "agent_tool_call_limit_exceeded"
  | "agent_unsupported_tool_calls"
  | "tool_binary_file"
  | "tool_empty_old_string"
  | "tool_file_not_found"
  | "tool_invalid_read_options"
  | "tool_not_file"
  | "tool_old_string_not_found"
  | "tool_old_string_not_unique"
  | "tool_path_outside_workspace"
  | "tool_read_offset_out_of_range"
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
