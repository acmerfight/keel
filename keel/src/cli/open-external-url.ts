import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/* v8 ignore start -- real OS browser launchers are process adapters; OAuth behavior is exercised through the injected opener contract. */
export async function openExternalUrl(
  url: URL,
  platform: NodeJS.Platform,
): Promise<void> {
  if (platform === "darwin") {
    await execFileAsync("open", [url.href]);
    return;
  }
  if (platform === "win32") {
    await execFileAsync("rundll32", ["url.dll,FileProtocolHandler", url.href]);
    return;
  }
  await execFileAsync("xdg-open", [url.href]);
}
/* v8 ignore stop */
