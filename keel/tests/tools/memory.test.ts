import { describe, expect, test } from "vitest";
import {
  validateAgentMemoryAdd,
  validateAgentMemoryForget,
} from "../../src/tools/memory.ts";

describe("agent memory mutation validation", () => {
  test.each([
    {
      currentUserText: "请记住：发布验证命令是 pnpm test:coverage。",
      memoryText: "发布验证命令是 pnpm test:coverage。",
    },
    {
      currentUserText:
        "Remember that the release verification command is pnpm test:coverage.",
      memoryText: "the release verification command is pnpm test:coverage.",
    },
    {
      currentUserText: "覚えておいて：リリース確認は pnpm test:coverage。",
      memoryText: "リリース確認は pnpm test:coverage。",
    },
  ])(
    `Given a current-user message in natural language,
    When memory_add supplies one exact contiguous durable-claim span,
    Then validation accepts it without parsing the request grammar`,
    ({ currentUserText, memoryText }) => {
      expect(
        validateAgentMemoryAdd({
          currentUserMessage: {
            role: "user",
            content: currentUserText,
            origin: { type: "user_prompt" },
          },
          text: memoryText,
        }),
      ).toEqual({ ok: true });
    },
  );

  test(`Given there is no eligible current-user message,
    When memory_add attempts a mutation,
    Then validation rejects the missing authority`, () => {
    expect(
      validateAgentMemoryAdd({
        currentUserMessage: null,
        text: "release tags use a v prefix",
      }),
    ).toEqual({
      ok: false,
      reason: "no eligible current-user message authorizes memory mutation",
    });
  });

  test(`Given memory_add broadens a fact beyond the current-user message,
    When validation checks the proposed durable text,
    Then it rejects the model-generated addition`, () => {
    expect(
      validateAgentMemoryAdd({
        currentUserMessage: {
          role: "user",
          content: "Remember that invoice IDs stay stable.",
          origin: { type: "user_prompt" },
        },
        text: "invoice IDs stay stable and audit logs never expire",
      }),
    ).toEqual({
      ok: false,
      reason:
        "text must be one exact contiguous span from the current-user message without paraphrasing or broadening",
    });
  });

  test(`Given a Chinese current-user request and one active memory ID,
    When memory_forget selects that exact active ID,
    Then validation accepts it without parsing the request grammar`, () => {
    expect(
      validateAgentMemoryForget({
        currentUserMessage: {
          role: "user",
          content: "请忘记发布标签前缀的记忆。",
          origin: { type: "user_prompt" },
        },
        id: "mem_release",
        entries: [{ id: "mem_release", text: "Release tags use a v prefix." }],
      }),
    ).toEqual({ ok: true });
  });

  test(`Given there is no eligible current-user message,
    When memory_forget attempts a mutation,
    Then validation rejects the missing authority`, () => {
    expect(
      validateAgentMemoryForget({
        currentUserMessage: null,
        id: "mem_release",
        entries: [{ id: "mem_release", text: "Release tags use a v prefix." }],
      }),
    ).toEqual({
      ok: false,
      reason: "no eligible current-user message authorizes memory mutation",
    });
  });

  test(`Given memory_forget selects an ID outside the active project-memory view,
    When validation checks the target,
    Then it rejects the destructive mutation`, () => {
    expect(
      validateAgentMemoryForget({
        currentUserMessage: {
          role: "user",
          content: "Forget mem_unknown.",
          origin: { type: "user_prompt" },
        },
        id: "mem_unknown",
        entries: [{ id: "mem_release", text: "Release tags use a v prefix." }],
      }),
    ).toEqual({
      ok: false,
      reason: "requested memory ID is not active in this project",
    });
  });
});
