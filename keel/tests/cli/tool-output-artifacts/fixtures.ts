import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactMessages } from "../../../src/agent/context-compaction.ts";
import { createToolOutputArtifactStore } from "../../../src/cli/tool-output-artifacts.ts";
import { runCli } from "../../../src/testing/cli-harness.ts";
import { requestWithMessagesSchema } from "../../../src/testing/cli-main-schemas.ts";
import {
  close,
  getPort,
  listen,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
} from "../../../src/testing/provider-sse-fixtures.ts";

export {
  close,
  compactMessages,
  createServer,
  createToolOutputArtifactStore,
  getPort,
  join,
  listen,
  mkdir,
  mkdtemp,
  readdir,
  requestWithMessagesSchema,
  rm,
  runCli,
  sseTextReplyWithUsage,
  sseToolCall,
  sseToolFinish,
  stat,
  tmpdir,
  writeFile,
};
export const ZERO_USAGE = {
  inputTokens: 0,
  cachedInputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
};

export function artifactRefsFrom(text: string): readonly string[] {
  return Array.from(
    text.matchAll(/tool-output:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/gu),
    (match) => match[0],
  );
}

export function firstArtifactRef(text: string): string {
  const ref = artifactRefsFrom(text)[0];
  if (ref === undefined) {
    throw new Error(`No artifact ref found in:\n${text}`);
  }
  return ref;
}

export function artifactPaths(
  home: string,
  ref: string,
): {
  readonly directory: string;
  readonly file: string;
} {
  const match = /^tool-output:([^/]+)\/([^/]+)$/u.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Invalid artifact ref in test: ${ref}`);
  }
  const directory = join(home, "artifacts", "tool-output", match[1]);
  return {
    directory,
    file: join(directory, `${match[2]}.txt`),
  };
}

export function oversizedReadFixture(options: {
  readonly start: string;
  readonly end: string;
  readonly fill: string;
}): string {
  return [
    options.start,
    options.fill.repeat(51_000),
    options.end,
    "tail beyond the read tool byte budget ".repeat(200),
  ].join("\n");
}

export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseReadToolCalls(
  calls: readonly { readonly id: string; readonly path: string }[],
): string {
  return sseData({
    choices: [
      {
        delta: {
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: call.path }),
            },
          })),
        },
        finish_reason: null,
      },
    ],
    usage: null,
  });
}
