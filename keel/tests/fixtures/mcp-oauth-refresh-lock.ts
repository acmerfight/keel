import { appendFile } from "node:fs/promises";
import { withMcpOAuthRefreshLock } from "../../src/mcp/oauth-refresh-lock.ts";

const [root, credentialId, tracePath, label, holdMsRaw] = process.argv.slice(2);
if (
  root === undefined ||
  credentialId === undefined ||
  tracePath === undefined ||
  label === undefined ||
  holdMsRaw === undefined
) {
  throw new Error("missing MCP OAuth refresh-lock fixture argument");
}
const holdMs = Number.parseInt(holdMsRaw, 10);
if (!Number.isSafeInteger(holdMs) || holdMs < 0) {
  throw new Error("invalid MCP OAuth refresh-lock fixture hold time");
}

await withMcpOAuthRefreshLock({
  root,
  credentialId,
  action: async () => {
    await appendFile(tracePath, `${label}:start\n`, "utf8");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, holdMs);
    });
    await appendFile(tracePath, `${label}:end\n`, "utf8");
  },
});
