import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

async function expectRipgrepError(
  action: () => unknown | Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await action();
    throw new Error("Expected ripgrep resolver to throw");
  } catch (error) {
    expect(error).toMatchObject({
      name: "KeelError",
      code: "tool_unavailable",
      message: expect.stringContaining(message),
    });
  }
}

describe("Ripgrep Provider", () => {
  test.sequential(`Given Keel has a bundled ripgrep provider installed,
    When the ripgrep resolver loads it,
    Then it returns an existing ripgrep binary path`, async () => {
    // Given
    vi.resetModules();
    const { resolveRipgrep } = await import("../../src/tools/ripgrep.ts");

    // When
    const ripgrep = await resolveRipgrep();

    // Then
    expect(ripgrep.provider).toBe("vscode-ripgrep");
    expect(ripgrep.path).toContain("rg");
    expect(existsSync(ripgrep.path)).toBe(true);
  });

  test.sequential(`Given the bundled ripgrep provider cannot be loaded,
    When the ripgrep resolver loads it,
    Then it reports the provider failure as a tool error`, async () => {
    // Given
    vi.resetModules();
    vi.doMock("@vscode/ripgrep", () => {
      throw new Error("platform package missing");
    });

    try {
      const { resolveRipgrep } = await import("../../src/tools/ripgrep.ts");

      // When / Then
      await expectRipgrepError(
        () => resolveRipgrep(),
        "bundled ripgrep is not available",
      );
    } finally {
      vi.doUnmock("@vscode/ripgrep");
      vi.resetModules();
    }
  });

  test.sequential(`Given the bundled ripgrep provider has an invalid contract,
    When the ripgrep resolver validates the provider,
    Then it reports the invalid provider contract as a tool error`, async () => {
    // Given
    vi.resetModules();
    vi.doMock("@vscode/ripgrep", () => ({
      rgPath: "",
    }));

    try {
      const { resolveRipgrep } = await import("../../src/tools/ripgrep.ts");

      // When / Then
      await expectRipgrepError(() => resolveRipgrep(), "valid rgPath");
    } finally {
      vi.doUnmock("@vscode/ripgrep");
      vi.resetModules();
    }
  });

  test.sequential(`Given the bundled ripgrep provider points to a missing binary,
    When the ripgrep resolver validates the binary,
    Then it reports that bundled ripgrep is not executable`, async () => {
    // Given
    vi.resetModules();
    vi.doMock("@vscode/ripgrep", () => ({
      rgPath: join(process.cwd(), "missing-rg"),
    }));

    try {
      const { resolveRipgrep } = await import("../../src/tools/ripgrep.ts");

      // When / Then
      await expectRipgrepError(() => resolveRipgrep(), "not executable");
    } finally {
      vi.doUnmock("@vscode/ripgrep");
      vi.resetModules();
    }
  });
});
