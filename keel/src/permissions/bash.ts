export interface BashPermissionRequest {
  readonly command: string;
  readonly cwd: string;
  readonly toolCallId: string;
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

export const denyBashPermissionPolicy: BashPermissionPolicy = {
  review: () => ({
    type: "deny",
    message: "Shell commands are disabled by the active bash policy.",
  }),
};

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
