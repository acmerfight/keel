import { createServer } from "node:http";
import type { Server } from "node:net";
import { expect } from "vitest";
import {
  readProviderModelsDiagnostic,
  runDoctor,
} from "../../../src/cli/doctor.ts";
import { KeelError } from "../../../src/core/error.ts";
import { runCli } from "../../../src/testing/cli-harness.ts";

export {
  createServer,
  KeelError,
  readProviderModelsDiagnostic,
  runCli,
  runDoctor,
};
export function expectRipgrepDiagnostics(stdout: string): void {
  expect(stdout).toContain("Keel doctor\n");
  expect(stdout).toContain("ripgrep: ok (vscode-ripgrep)");
  expect(stdout).toContain("ripgrep path:");
  expect(stdout).toMatch(/^ripgrep version: ripgrep\s+\S+/m);
}

export function runtimeWithEnv(env: Record<string, string>) {
  return {
    env: (key: string) => env[key],
  };
}

export async function readOkRipgrepDiagnostic() {
  return {
    provider: "vscode-ripgrep",
    path: "/test/rg",
    version: "ripgrep 1.0.0",
  };
}

export function getPort(server: Server): number {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("Server not listening on a TCP port");
  }
  return addr.port;
}

export function listen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
