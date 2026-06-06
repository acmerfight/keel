import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createRipgrepCommandFromVscodeModule,
  resolveRipgrep,
} from "../../src/tools/ripgrep.ts";

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

function readVersion(path: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      path,
      ["--version"],
      { encoding: "utf8", timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(stderr.trim() === "" ? error.message : stderr.trim()),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

describe("Ripgrep Provider", () => {
  test(`Given Keel has a bundled ripgrep provider installed,
    When the ripgrep resolver loads it,
    Then it returns an existing executable ripgrep binary path`, async () => {
    // Given / When
    const ripgrep = await resolveRipgrep();

    // Then
    expect(ripgrep.provider).toBe("vscode-ripgrep");
    expect(ripgrep.path).toContain("rg");
    expect(existsSync(ripgrep.path)).toBe(true);
    expect(() => accessSync(ripgrep.path, constants.X_OK)).not.toThrow();
  });

  test(`Given Keel resolves the bundled ripgrep binary,
    When that binary is executed for its version,
    Then it responds as ripgrep`, async () => {
    // Given
    const ripgrep = await resolveRipgrep();

    // When
    const version = await readVersion(ripgrep.path);

    // Then
    expect(version).toMatch(/^ripgrep\s+\S+/);
  });

  test(`Given the bundled ripgrep provider has an invalid contract,
    When the ripgrep resolver validates that provider data,
    Then it reports the invalid provider contract as a tool error`, async () => {
    // Given
    const providerData: unknown = { rgPath: "" };

    // When / Then
    await expectRipgrepError(
      () => createRipgrepCommandFromVscodeModule(providerData),
      "valid rgPath",
    );
  });

  test(`Given the bundled ripgrep provider points to a missing binary,
    When the ripgrep resolver validates that provider data,
    Then it reports that bundled ripgrep is not executable`, async () => {
    // Given
    const providerData: unknown = { rgPath: join(process.cwd(), "missing-rg") };

    // When / Then
    await expectRipgrepError(
      () => createRipgrepCommandFromVscodeModule(providerData),
      "not executable",
    );
  });

  test(`Given the bundled ripgrep provider points to a directory,
    When the ripgrep resolver validates that provider data,
    Then it reports that bundled ripgrep is not executable`, async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "keel-ripgrep-"));
    const providerData: unknown = { rgPath: directory };

    try {
      // When / Then
      await expectRipgrepError(
        () => createRipgrepCommandFromVscodeModule(providerData),
        "not executable",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
