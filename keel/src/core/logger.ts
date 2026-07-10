const DEBUG_ENV_KEY = "KEEL_DEBUG";

export function debugLog(message: string): void {
  if (process.env[DEBUG_ENV_KEY] !== "1") return;
  process.stderr.write(`[keel:debug] ${message}\n`);
}
