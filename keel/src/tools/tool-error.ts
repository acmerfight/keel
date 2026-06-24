import type { z } from "zod";

function zodIssuePath(issue: z.core.$ZodIssue): string {
  return issue.path.length === 0
    ? "arguments"
    : issue.path.map(String).join(".");
}

export function toolCallValidationError(
  prefix: string,
  toolName: string,
  error?: z.ZodError,
): Error {
  const message = `${prefix} for ${toolName}`;
  if (error === undefined) {
    return new Error(message);
  }

  const issues = error.issues
    .map((issue) => `${zodIssuePath(issue)}: ${issue.message}`)
    .join("; ");
  return new Error(`${message}: ${issues}`);
}

export function invalidBuiltinToolCallError(
  toolName: string,
  error?: z.ZodError,
): Error {
  return toolCallValidationError("Invalid builtin tool call", toolName, error);
}
