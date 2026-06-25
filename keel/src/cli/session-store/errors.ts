export class SessionStoreError extends Error {}

export function sessionStoreError(message: string): never {
  throw new SessionStoreError(message);
}

export function hasNodeErrorCode(
  error: unknown,
  expectedCode: string,
): boolean {
  return (
    error instanceof Error && "code" in error && error.code === expectedCode
  );
}

export function formatNestedSessionStoreError(
  error: SessionStoreError,
): string {
  return error.message.replace(/^Error: /u, "");
}
