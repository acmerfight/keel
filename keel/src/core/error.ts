const recoverableToolErrorCodes = [
  "tool_binary_file",
  "tool_file_exists",
  "tool_file_not_found",
  "tool_file_not_read",
  "tool_empty_command",
  "tool_empty_old_string",
  "tool_empty_pattern",
  "tool_edit_overlap",
  "tool_edit_no_op",
  "tool_file_too_large",
  "tool_invalid_pattern",
  "tool_invalid_ls_options",
  "tool_invalid_patch",
  "tool_not_file",
  "tool_not_directory",
  "tool_old_string_not_found",
  "tool_old_string_not_unique",
  "tool_path_ignored",
  "tool_path_outside_workspace",
  "tool_patch_hunk_not_found",
  "tool_read_offset_out_of_range",
  "tool_search_unavailable",
  "tool_unsupported_patch_operation",
] as const;

export type RecoverableToolErrorCode =
  (typeof recoverableToolErrorCodes)[number];

export type KeelErrorCode =
  | "agent_missing_stop"
  | RecoverableToolErrorCode
  | "tool_aborted"
  | "tool_invalid_bash_timeout"
  | "tool_invalid_read_options"
  | "tool_unavailable"
  | "provider_auth_failed"
  | "provider_rate_limited"
  | "provider_server_error"
  | "provider_context_overflow"
  | "provider_http_error"
  | "provider_protocol_error"
  | "provider_aborted"
  | "provider_network_error";

const recoverableToolErrorCodeSet: ReadonlySet<KeelErrorCode> = new Set(
  recoverableToolErrorCodes,
);

export function isRecoverableToolErrorCode(
  code: KeelErrorCode,
): code is RecoverableToolErrorCode {
  return recoverableToolErrorCodeSet.has(code);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
