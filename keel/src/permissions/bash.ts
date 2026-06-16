export type BashPolicy = "ask" | "deny" | "trusted";

// BashPolicy is the user-facing CLI vocabulary; BashMode is the internal state
// used to derive tool exposure and approval behavior.
export type BashMode = "disabled" | "ask" | "trusted";

export function bashModeFromPolicy(policy: BashPolicy): BashMode {
  return policy === "deny" ? "disabled" : policy;
}

export function bashModeExposesTool(mode: BashMode): boolean {
  return mode !== "disabled";
}

export interface BashPermissionRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export type BashPermissionDecision =
  | {
      readonly type: "allow";
      readonly scope: "once" | "session";
    }
  | {
      readonly type: "deny";
      readonly message: string;
    };

export interface BashPermissionPolicy {
  readonly review: (
    request: BashPermissionRequest,
  ) => BashPermissionDecision | Promise<BashPermissionDecision>;
}

function sessionKey(request: BashPermissionRequest): string {
  return JSON.stringify([request.cwd, request.command]);
}

export function createSessionBashPermissionPolicy(options: {
  readonly prompt: (
    request: BashPermissionRequest,
  ) => BashPermissionDecision | Promise<BashPermissionDecision>;
}): BashPermissionPolicy {
  const approved = new Set<string>();

  return {
    review: async (request) => {
      const key = sessionKey(request);
      if (approved.has(key)) {
        return { type: "allow", scope: "session" };
      }

      const decision = await options.prompt(request);
      if (decision.type === "allow" && decision.scope === "session") {
        approved.add(key);
      }
      return decision;
    },
  };
}
