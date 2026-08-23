import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runAgent } from "../../../src/agent/loop.ts";
import { defaultStopPolicy } from "../../../src/agent/stop-policy.ts";
import {
  createFakeProvider,
  fakeResponse,
  fakeToolResponse,
} from "../../../src/llm/providers/fake.ts";
import {
  collect,
  createWorkspace,
  freshSignal,
} from "../../../src/testing/file-editing-fixtures.ts";

describe("File Editing Final Edit Success", () => {
  test(`Given a workspace file with a bug,
    When the agent reads it then edits it,
    Then the agent replies with a summary after the edit`, async () => {
    // Given
    const workspace = await createWorkspace();
    await writeFile(join(workspace, "app.ts"), "const x = nul;\n", "utf8");
    const provider = createFakeProvider([
      fakeToolResponse("read", { path: "app.ts" }),
      fakeToolResponse("edit", {
        path: "app.ts",
        edits: [{ oldText: "nul", newText: "null" }],
      }),
      fakeResponse("Fixed the null typo."),
    ]);

    try {
      // When
      const events = await collect(
        runAgent({
          workspace,
          provider,
          userMessage: "fix the bug in app.ts",
          systemPrompt: "You are a helpful assistant.",
          signal: freshSignal(),
          bash: { kind: "trusted" },
          stopPolicy: defaultStopPolicy(),
        }),
      );

      // Then
      expect(await readFile(join(workspace, "app.ts"), "utf8")).toBe(
        "const x = null;\n",
      );
      expect(events).toContainEqual({
        type: "text",
        text: "Fixed the null typo.",
      });
      expect(events.filter((e) => e.type === "end")).toHaveLength(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
