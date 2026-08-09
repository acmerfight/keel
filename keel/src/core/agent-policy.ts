export const delegatingAgentPolicies = ["explicit", "auto"] as const;
export const agentPolicies = ["off", ...delegatingAgentPolicies] as const;

export type AgentPolicy = (typeof agentPolicies)[number];
export type DelegatingAgentPolicy = Exclude<AgentPolicy, "off">;

export type AgentPolicyConfiguration =
  | {
      readonly agentPolicy: "off";
      readonly maxCostUsd?: number;
    }
  | {
      readonly agentPolicy: DelegatingAgentPolicy;
      readonly maxCostUsd: number;
    };
