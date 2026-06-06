import { resolveRipgrep } from "../tools/ripgrep.ts";

export interface DoctorResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runDoctor(): Promise<DoctorResult> {
  try {
    const ripgrep = await resolveRipgrep();
    return {
      exitCode: 0,
      stdout: [
        "Keel doctor",
        `ripgrep: ok (${ripgrep.provider})`,
        `ripgrep path: ${ripgrep.path}`,
        "",
      ].join("\n"),
      stderr: "",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: "Keel doctor\n",
      stderr: `ripgrep: failed: ${message}\n`,
    };
  }
}
