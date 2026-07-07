import type { z } from "zod";

function zodIssuePath(issue: z.core.$ZodIssue): string {
  return issue.path.length === 0
    ? "arguments"
    : issue.path.map(String).join(".");
}

export function zodIssuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${zodIssuePath(issue)}: ${issue.message}`)
    .join("; ");
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

  return new Error(`${message}: ${zodIssuesText(error)}`);
}

export function invalidBuiltinToolCallError(
  toolName: string,
  error?: z.ZodError,
): Error {
  return toolCallValidationError("Invalid builtin tool call", toolName, error);
}
