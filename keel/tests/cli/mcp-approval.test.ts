import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { LineReader } from "../../src/cli/interactive-session/line-reader.ts";
import { createMcpPermissionPolicy } from "../../src/cli/mcp-approval.ts";

function lineReaderReturning(answer: string | null): LineReader {
  return {
    readLine: async () => null,
    readLineAfter: async () => answer,
    drainLinesAfter: () => [],
    restoreLines: () => {},
    sequence: () => 7,
    needsInput: () => true,
    pendingInputCount: () => 0,
  };
}

const request = {
  origin: "https://catalog.example",
  serverId: "catalog",
  configurationDigest: "a".repeat(64),
  rawToolName: "search",
  descriptorDigest: "b".repeat(64),
  authorizationIdentity: { kind: "anonymous" },
  arguments: { query: "otters" },
  signal: new AbortController().signal,
} as const;

describe("MCP Approval", () => {
  test.each([
    ["y", { type: "allow" }],
    [" YES ", { type: "allow" }],
    [
      "n",
      {
        type: "deny",
        message: "User did not approve this MCP tool call.",
      },
    ],
    [
      null,
      {
        type: "deny",
        message: "MCP approval was interrupted or input closed.",
      },
    ],
  ] as const)(
    `Given a prompted MCP call receives answer %j,
    When the exact one-call approval is reviewed,
    Then the adapter returns the fail-closed decision and restores steering mode`,
    async (answer, expected) => {
      // Given
      const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-home-"));
      let stderr = "";
      const lifecycle: string[] = [];
      const policy = createMcpPermissionPolicy({
        runtime: { env: (key) => (key === "KEEL_HOME" ? home : undefined) },
        projectRoot: "/project",
        prompt: {
          kind: "interactive",
          lineReader: lineReaderReturning(answer),
          writeStderr: (text: string) => {
            stderr += text;
          },
          onPromptStart: () => lifecycle.push("approval"),
          onPromptEnd: () => lifecycle.push("steer"),
        },
      });

      try {
        // When
        const decision = await policy.review(request);

        // Then
        expect(decision).toEqual(expected);
        expect(stderr).toContain("Approve MCP tool call?");
        expect(stderr).toContain("origin: https://catalog.example");
        expect(stderr).toContain("tool: catalog/search");
        expect(lifecycle).toEqual(["approval", "steer"]);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  test(`Given a session cannot prompt,
    When an MCP call asks for approval,
    Then the configured deny policy fails closed without external input`, async () => {
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-home-"));
    try {
      const policy = createMcpPermissionPolicy({
        runtime: { env: (key) => (key === "KEEL_HOME" ? home : undefined) },
        projectRoot: "/project",
        prompt: { kind: "headless", deniedMessage: "terminal required" },
      });

      await expect(policy.review(request)).resolves.toEqual({
        type: "deny",
        message: "terminal required",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the saved MCP approval store is malformed,
    When an interactive MCP call asks for one-time approval,
    Then the user can still review and allow that exact call`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-home-"));
    await writeFile(join(home, "mcp-project-approvals.json"), "{", "utf8");
    let stderr = "";
    const lifecycle: string[] = [];
    const policy = createMcpPermissionPolicy({
      runtime: { env: (key) => (key === "KEEL_HOME" ? home : undefined) },
      projectRoot: "/project",
      prompt: {
        kind: "interactive",
        lineReader: lineReaderReturning("y"),
        writeStderr: (text: string) => {
          stderr += text;
        },
        onPromptStart: () => lifecycle.push("approval"),
        onPromptEnd: () => lifecycle.push("steer"),
      },
    });

    try {
      // When
      const decision = await policy.review(request);

      // Then
      expect(decision).toEqual({ type: "allow" });
      expect(stderr).toContain("cannot read MCP project approvals");
      expect(stderr).toContain("saved MCP approvals are unavailable");
      expect(stderr).toContain("Approve MCP tool call?");
      expect(lifecycle).toEqual(["approval", "steer"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the saved MCP approval store is malformed,
    When a headless MCP call needs an exact saved approval,
    Then the denial explains the approval store failure`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-home-"));
    await writeFile(join(home, "mcp-project-approvals.json"), "{", "utf8");
    const policy = createMcpPermissionPolicy({
      runtime: { env: (key) => (key === "KEEL_HOME" ? home : undefined) },
      projectRoot: "/project",
      prompt: { kind: "headless", deniedMessage: "terminal required" },
    });

    try {
      // When / Then
      await expect(policy.review(request)).resolves.toEqual({
        type: "deny",
        message: expect.stringContaining("cannot read MCP project approvals"),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the saved MCP approval store is malformed,
    When the user asks to save a project approval,
    Then the call is denied with a repairable save diagnostic`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-home-"));
    await writeFile(join(home, "mcp-project-approvals.json"), "{", "utf8");
    const policy = createMcpPermissionPolicy({
      runtime: { env: (key) => (key === "KEEL_HOME" ? home : undefined) },
      projectRoot: "/project",
      prompt: {
        kind: "interactive",
        lineReader: lineReaderReturning("s"),
        writeStderr: () => {},
        onPromptStart: () => {},
        onPromptEnd: () => {},
      },
    });

    try {
      // When / Then
      await expect(policy.review(request)).resolves.toEqual({
        type: "deny",
        message: expect.stringContaining(
          "Use y to allow once after repairing or clearing MCP project approvals",
        ),
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given the approval runtime raises an implementation fault,
    When an MCP call asks for approval,
    Then the permission policy preserves the original fault identity`, async () => {
    // Given
    const failure = new Error("runtime exploded");
    const policy = createMcpPermissionPolicy({
      runtime: {
        env: () => {
          throw failure;
        },
      },
      projectRoot: "/project",
      prompt: { kind: "headless", deniedMessage: "terminal required" },
    });

    // When / Then
    await expect(policy.review(request)).rejects.toBe(failure);
  });

  test(`Given the approval runtime fails unexpectedly while saving,
    When the user asks to save a project approval,
    Then the permission policy preserves the original fault identity`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-home-"));
    const failure = new Error("save exploded");
    let saving = false;
    const policy = createMcpPermissionPolicy({
      runtime: {
        env: (key) => {
          if (saving) throw failure;
          return key === "KEEL_HOME" ? home : undefined;
        },
      },
      projectRoot: "/project",
      prompt: {
        kind: "interactive",
        lineReader: {
          ...lineReaderReturning("s"),
          readLineAfter: async () => {
            saving = true;
            return "s";
          },
        },
        writeStderr: () => {},
        onPromptStart: () => {},
        onPromptEnd: () => {},
      },
    });

    try {
      // When / Then
      await expect(policy.review(request)).rejects.toBe(failure);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test(`Given one exact OAuth-bound MCP project approval is saved,
    When project, server, descriptor, authorization, or arguments drift,
    Then only the semantically identical request reuses the grant`, async () => {
    // Given
    const home = await mkdtemp(join(tmpdir(), "keel-mcp-approval-home-"));
    const runtime = {
      env: (key: string) => (key === "KEEL_HOME" ? home : undefined),
    };
    const oauthRequest = {
      ...request,
      authorizationIdentity: {
        kind: "oauth",
        issuer: "https://auth.example",
        clientId: "client-one",
        grantId: "00000000-0000-4000-8000-000000000001",
      },
      arguments: { options: { limit: 5, exact: true }, query: "otters" },
    } as const;
    const savingPolicy = createMcpPermissionPolicy({
      runtime,
      projectRoot: "/project",
      prompt: {
        kind: "interactive",
        lineReader: lineReaderReturning("s"),
        writeStderr: () => {},
        onPromptStart: () => {},
        onPromptEnd: () => {},
      },
    });

    try {
      expect(await savingPolicy.review(oauthRequest)).toEqual({
        type: "allow",
      });
      const headlessPolicy = (projectRoot: string) =>
        createMcpPermissionPolicy({
          runtime,
          projectRoot,
          prompt: { kind: "headless", deniedMessage: "no exact grant" },
        });

      // When / Then
      await expect(
        headlessPolicy("/project").review({
          ...oauthRequest,
          arguments: {
            query: "otters",
            options: { exact: true, limit: 5 },
          },
        }),
      ).resolves.toEqual({ type: "allow" });

      const changedRequests = [
        {
          label: "project",
          projectRoot: "/other-project",
          request: oauthRequest,
        },
        {
          label: "origin",
          projectRoot: "/project",
          request: { ...oauthRequest, origin: "https://other.example" },
        },
        {
          label: "server",
          projectRoot: "/project",
          request: { ...oauthRequest, serverId: "other" },
        },
        {
          label: "configuration",
          projectRoot: "/project",
          request: { ...oauthRequest, configurationDigest: "c".repeat(64) },
        },
        {
          label: "tool",
          projectRoot: "/project",
          request: { ...oauthRequest, rawToolName: "other" },
        },
        {
          label: "descriptor",
          projectRoot: "/project",
          request: { ...oauthRequest, descriptorDigest: "d".repeat(64) },
        },
        {
          label: "issuer",
          projectRoot: "/project",
          request: {
            ...oauthRequest,
            authorizationIdentity: {
              ...oauthRequest.authorizationIdentity,
              issuer: "https://other-auth.example",
            },
          },
        },
        {
          label: "OAuth client",
          projectRoot: "/project",
          request: {
            ...oauthRequest,
            authorizationIdentity: {
              ...oauthRequest.authorizationIdentity,
              clientId: "client-two",
            },
          },
        },
        {
          label: "authorization grant",
          projectRoot: "/project",
          request: {
            ...oauthRequest,
            authorizationIdentity: {
              ...oauthRequest.authorizationIdentity,
              grantId: "00000000-0000-4000-8000-000000000002",
            },
          },
        },
        {
          label: "arguments",
          projectRoot: "/project",
          request: {
            ...oauthRequest,
            arguments: {
              options: { exact: true, limit: 6 },
              query: "otters",
            },
          },
        },
      ];
      for (const changed of changedRequests) {
        await expect(
          headlessPolicy(changed.projectRoot).review(changed.request),
          changed.label,
        ).resolves.toEqual({ type: "deny", message: "no exact grant" });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
