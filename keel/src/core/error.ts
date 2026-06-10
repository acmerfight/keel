export type RecoverableToolErrorCode =
  | "tool_binary_file"
  | "tool_file_exists"
  | "tool_file_not_found"
  | "tool_empty_command"
  | "tool_empty_old_string"
  | "tool_empty_pattern"
  | "tool_not_file"
  | "tool_not_directory"
  | "tool_old_string_not_found"
  | "tool_old_string_not_unique"
  | "tool_path_ignored"
  | "tool_path_outside_workspace";

export type KeelErrorCode =
  | "agent_missing_stop"
  | "agent_tool_call_limit_exceeded"
  | "agent_unsupported_tool_calls"
  | RecoverableToolErrorCode
  | "tool_aborted"
  | "tool_invalid_bash_timeout"
  | "tool_invalid_read_options"
  | "tool_read_offset_out_of_range"
  | "tool_unavailable"
  | "provider_auth_failed"
  | "provider_rate_limited"
  | "provider_server_error"
  | "provider_http_error"
  | "provider_protocol_error"
  | "provider_aborted"
  | "provider_network_error";

export class KeelError extends Error {
  readonly code: KeelErrorCode;
  readonly recovery?: string;

  constructor(
    code: RecoverableToolErrorCode,
    message: string,
    recovery: string,
  );
  constructor(
    code: Exclude<KeelErrorCode, RecoverableToolErrorCode>,
    message: string,
    recovery?: string,
  );
  constructor(code: KeelErrorCode, message: string, recovery?: string) {
    super(message);
    this.name = "KeelError";
    this.code = code;
    if (recovery !== undefined) {
      this.recovery = recovery;
    }
  }
}
