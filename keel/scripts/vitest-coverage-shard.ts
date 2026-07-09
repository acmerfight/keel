import { spawnSync } from "node:child_process";

const shard = parseShard(
  process.argv.slice(2),
  // biome-ignore lint/complexity/useLiteralKeys: ProcessEnv uses an index signature under noPropertyAccessFromIndexSignature.
  process.env["VITEST_SHARD"],
);

const result = spawnSync(
  "vitest",
  [
    "run",
    "--coverage",
    "--reporter=blob",
    "--coverage.reporter=json",
    "--coverage.thresholds.statements=0",
    "--coverage.thresholds.branches=0",
    "--coverage.thresholds.functions=0",
    "--coverage.thresholds.lines=0",
    `--shard=${shard}`,
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

if (result.error !== undefined) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);

function parseShard(args: readonly string[], envShard: string | undefined) {
  const argvShard = args
    .filter((arg) => arg !== "--")
    .find((arg) => arg.startsWith("--shard="));
  const shard = argvShard?.slice("--shard=".length) ?? envShard;
  if (shard === undefined || !/^[1-9]\d*\/[1-9]\d*$/.test(shard)) {
    process.stderr.write(
      "Usage: VITEST_SHARD=<index>/<count> pnpm test:coverage:shard\n",
    );
    process.exit(1);
  }
  return shard;
}
