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
  "tool_invalid_git_ref",
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
  "tool_project_instructions_not_visible",
  "tool_read_offset_out_of_range",
  "tool_search_unavailable",
  "tool_unsupported_patch_operation",
] as const;

export type RecoverableToolErrorCode =
  (typeof recoverableToolErrorCodes)[number];

export const keelErrorCodes = [
  "agent_missing_stop",
  "goal_terminal_outcome_invalid",
  ...recoverableToolErrorCodes,
  "tool_aborted",
  "tool_invalid_bash_timeout",
  "tool_invalid_read_options",
  "tool_unavailable",
  "provider_auth_failed",
  "provider_rate_limited",
  "provider_server_error",
  "provider_context_overflow",
  "provider_http_error",
  "provider_protocol_error",
  "provider_aborted",
  "provider_network_error",
  "first_response_timeout",
  "stream_inactivity_timeout",
] as const;

export type KeelErrorCode = (typeof keelErrorCodes)[number];

export const providerRequestTerminalErrorCodes = [
  ...keelErrorCodes,
  "provider_unexpected_error",
  "provider_consumer_closed",
] as const;

export type ProviderRequestTerminalErrorCode =
  (typeof providerRequestTerminalErrorCodes)[number];

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

export function isAbortThrow(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true) return true;
  return (
    error instanceof Error &&
    (error.name === "AbortError" ||
      ("code" in error &&
        (error.code === "ABORT_ERR" ||
          error.code === "provider_aborted" ||
          error.code === "tool_aborted")))
  );
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
