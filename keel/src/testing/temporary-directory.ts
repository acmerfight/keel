import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createTemporaryDirectory(
  prefix: string,
): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export async function removeTemporaryDirectory(path: string): Promise<void> {
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25,
  });
}
