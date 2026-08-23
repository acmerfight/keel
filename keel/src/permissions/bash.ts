interface BashPermissionReviewRequest {
  readonly command: string;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

type BashPermissionDecision =
  | { readonly type: "allow" }
  | { readonly type: "deny"; readonly message: string };

export interface BashPermissionPolicy {
  readonly review: (
    request: BashPermissionReviewRequest,
  ) => BashPermissionDecision | Promise<BashPermissionDecision>;
}

export type MainBashRuntime<
  Permission extends BashPermissionPolicy = BashPermissionPolicy,
> =
  | { readonly kind: "trusted" }
  | { readonly kind: "reviewed"; readonly permission: Permission };

export type ChildBashRuntime = { readonly kind: "disabled" };

export type BashRuntime<
  Permission extends BashPermissionPolicy = BashPermissionPolicy,
> = MainBashRuntime<Permission> | ChildBashRuntime;

export function bashRuntimeExposesTool(runtime: BashRuntime): boolean {
  return runtime.kind !== "disabled";
}

export function createBashPermissionPolicy(
  review: BashPermissionPolicy["review"],
): BashPermissionPolicy {
  return { review };
}
