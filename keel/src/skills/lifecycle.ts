import {
  type ActiveSkillStatus,
  MODEL_SELECTED_SKILL_ACTIVATIONS_PER_TURN,
  type SkillActivation,
  type SkillActivationCapability,
  type SkillActivationRecord,
  type SkillActivationResult,
  type SkillCatalog,
  type SkillLifecycleState,
  type SkillScope,
  type WorkflowSkill,
  WorkflowSkillError,
} from "./model.ts";

export interface CreateSkillActivationOptions {
  readonly initialState?: SkillLifecycleState;
  readonly now?: () => string;
}

export function copySkillActivation(
  activation: SkillActivation,
): SkillActivation {
  return {
    descriptorId: activation.descriptorId,
    packageId: activation.packageId,
    qualifiedName: activation.qualifiedName,
    scope: activation.scope,
    name: activation.name,
    relativePath: activation.relativePath,
    resourcePaths: [...activation.resourcePaths],
    digest: activation.digest,
    trigger: activation.trigger,
    args: activation.args,
    contentSnapshot: activation.contentSnapshot,
    activatedAt: activation.activatedAt,
  };
}

export function copySkillLifecycleState(
  state: SkillLifecycleState,
): SkillLifecycleState {
  return {
    skillActivations: state.skillActivations.map(copySkillActivation),
    activeSkillIds: [...state.activeSkillIds],
  };
}

export function skillLifecycleStatesEqual(
  left: SkillLifecycleState,
  right: SkillLifecycleState,
): boolean {
  if (left.activeSkillIds.length !== right.activeSkillIds.length) return false;
  if (
    left.activeSkillIds.some((id, index) => id !== right.activeSkillIds[index])
  ) {
    return false;
  }
  if (left.skillActivations.length !== right.skillActivations.length) {
    return false;
  }
  return left.skillActivations.every((activation, index) => {
    const candidate = right.skillActivations[index];
    return (
      candidate !== undefined &&
      activation.descriptorId === candidate.descriptorId &&
      activation.packageId === candidate.packageId &&
      activation.qualifiedName === candidate.qualifiedName &&
      activation.scope === candidate.scope &&
      activation.name === candidate.name &&
      activation.relativePath === candidate.relativePath &&
      activation.digest === candidate.digest &&
      activation.trigger === candidate.trigger &&
      activation.args === candidate.args &&
      activation.contentSnapshot === candidate.contentSnapshot &&
      activation.activatedAt === candidate.activatedAt &&
      activation.resourcePaths.length === candidate.resourcePaths.length &&
      activation.resourcePaths.every(
        (path, resourceIndex) =>
          path === candidate.resourcePaths[resourceIndex],
      )
    );
  });
}

export function workflowSkillFromActivation(
  activation: SkillActivation,
): WorkflowSkill {
  return {
    id: activation.descriptorId,
    packageId: activation.packageId,
    qualifiedName: activation.qualifiedName,
    scope: activation.scope,
    digest: activation.digest,
    relativePath: activation.relativePath,
    name: activation.name,
    resourcePaths: [...activation.resourcePaths],
    content: activation.contentSnapshot,
  };
}

export function skillActivationFromWorkflowSkill(options: {
  readonly skill: WorkflowSkill;
  readonly trigger: SkillActivation["trigger"];
  readonly args: string;
  readonly activatedAt: string;
}): SkillActivation {
  return {
    descriptorId: options.skill.id,
    packageId: options.skill.packageId,
    qualifiedName: options.skill.qualifiedName,
    scope: options.skill.scope,
    name: options.skill.name,
    relativePath: options.skill.relativePath,
    resourcePaths: [...options.skill.resourcePaths],
    digest: options.skill.digest,
    trigger: options.trigger,
    args: options.args,
    contentSnapshot: options.skill.content,
    activatedAt: options.activatedAt,
  };
}

function activationRecord(activation: SkillActivation): SkillActivationRecord {
  return {
    name: activation.qualifiedName,
    relativePath: activation.relativePath,
    trigger: activation.trigger,
  };
}

function validateSkillLifecycleState(state: SkillLifecycleState): void {
  const activationIds = new Set(
    state.skillActivations.map((activation) => activation.descriptorId),
  );
  const activeIds = new Set<string>();
  const activePackages = new Set<string>();
  for (const id of state.activeSkillIds) {
    if (!activationIds.has(id)) {
      throw new WorkflowSkillError(
        `Error: active workflow skill id ${JSON.stringify(id)} has no activation snapshot.`,
      );
    }
    if (activeIds.has(id)) {
      throw new WorkflowSkillError(
        `Error: active workflow skill id ${JSON.stringify(id)} is duplicated.`,
      );
    }
    activeIds.add(id);
    const activation = activeActivationForId(state.skillActivations, id);
    if (activePackages.has(activation.packageId)) {
      throw new WorkflowSkillError(
        `Error: workflow skill package ${JSON.stringify(activation.packageId)} has multiple active snapshots.`,
      );
    }
    activePackages.add(activation.packageId);
  }
}

function activeActivationForId(
  activations: readonly SkillActivation[],
  id: string,
): SkillActivation {
  const activation = activations.findLast(
    (candidate) => candidate.descriptorId === id,
  );
  /* v8 ignore next 5 -- lifecycle state is validated before active ids reach this internal lookup. */
  if (activation === undefined) {
    throw new WorkflowSkillError(
      `Error: active workflow skill id ${JSON.stringify(id)} has no activation snapshot.`,
    );
  }
  return activation;
}

function lookupScopeAndName(lookup: string): {
  readonly scope?: SkillScope;
  readonly name: string;
} {
  const segments = lookup.split(":");
  if (segments.length === 1) return { name: lookup };
  const scope = segments[0];
  const name = segments.at(-1);
  /* v8 ignore next 5 -- splitting a string always yields at least one segment. */
  if (name === undefined) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${JSON.stringify(lookup)} is not active.`,
    );
  }
  if (
    scope !== "repo" &&
    scope !== "user" &&
    scope !== "system" &&
    scope !== "extra"
  ) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${JSON.stringify(lookup)} is not active.`,
    );
  }
  return { scope, name };
}

function resolveActive(
  active: readonly SkillActivation[],
  lookup: string,
): SkillActivation {
  const direct = active.filter(
    (activation) =>
      activation.qualifiedName === lookup || activation.packageId === lookup,
  );
  const directMatch = direct.length === 1 ? direct[0] : undefined;
  if (directMatch !== undefined) return directMatch;
  const parts = lookupScopeAndName(lookup);
  const matches = active.filter(
    (activation) =>
      activation.name === parts.name &&
      (parts.scope === undefined || activation.scope === parts.scope),
  );
  const uniqueMatch = matches.length === 1 ? matches[0] : undefined;
  if (uniqueMatch !== undefined) return uniqueMatch;
  if (matches.length > 1) {
    throw new WorkflowSkillError(
      `Error: workflow skill ${JSON.stringify(lookup)} is ambiguous; use one of: ${matches
        .map((activation) => activation.qualifiedName)
        .join(", ")}.`,
    );
  }
  throw new WorkflowSkillError(
    `Error: workflow skill ${JSON.stringify(lookup)} is not active.`,
  );
}

export function createSkillActivation(
  catalog: SkillCatalog,
  options: CreateSkillActivationOptions = {},
): SkillActivationCapability {
  const initialState = copySkillLifecycleState(
    options.initialState ?? { skillActivations: [], activeSkillIds: [] },
  );
  validateSkillLifecycleState(initialState);
  const activations = [...initialState.skillActivations];
  const activeSkillIds = [...initialState.activeSkillIds];
  const selectableIds = new Set<string>();
  let modelSelectedThisTurn = 0;
  const now = options.now ?? (() => new Date().toISOString());

  const state = (): SkillLifecycleState =>
    copySkillLifecycleState({ skillActivations: activations, activeSkillIds });
  const active = (): readonly SkillActivation[] =>
    activeSkillIds.map((id) => activeActivationForId(activations, id));
  const activateSkill = (
    skill: WorkflowSkill,
    trigger: SkillActivation["trigger"],
    args: string,
  ): SkillActivationResult => {
    const existing = active().find(
      (activation) => activation.descriptorId === skill.id,
    );
    if (existing !== undefined) {
      return {
        activation: copySkillActivation(existing),
        skill: workflowSkillFromActivation(existing),
        newlyActivated: false,
      };
    }
    const samePackage = active().find(
      (activation) => activation.packageId === skill.packageId,
    );
    if (samePackage !== undefined) {
      throw new WorkflowSkillError(
        `Error: workflow skill ${JSON.stringify(samePackage.qualifiedName)} is already active with a different digest; reload it explicitly.`,
      );
    }
    const activation = skillActivationFromWorkflowSkill({
      skill,
      trigger,
      args,
      activatedAt: now(),
    });
    activations.push(activation);
    activeSkillIds.push(activation.descriptorId);
    return {
      activation: copySkillActivation(activation),
      skill: workflowSkillFromActivation(activation),
      newlyActivated: true,
      record: activationRecord(activation),
    };
  };

  return {
    beginTurn: () => {
      modelSelectedThisTurn = 0;
    },
    expose: (skills) => {
      for (const skill of skills) selectableIds.add(skill.id);
    },
    registerExplicit: (skills) =>
      skills.map(
        (skill) => activateSkill(skill, "user_explicit", "").activation,
      ),
    activateExplicit: (skill, args) =>
      activateSkill(skill, "user_explicit", args),
    search: (query) => {
      const matches = catalog.search(query);
      for (const skill of matches) selectableIds.add(skill.id);
      return matches;
    },
    readResource: (lookup, path) => {
      const activation = resolveActive(active(), lookup);
      return catalog.readPackageResource(
        activation.packageId,
        activation.digest,
        path,
      );
    },
    activate: (name) => {
      if (modelSelectedThisTurn >= MODEL_SELECTED_SKILL_ACTIVATIONS_PER_TURN) {
        throw new WorkflowSkillError(
          `Error: this turn already activated ${MODEL_SELECTED_SKILL_ACTIVATIONS_PER_TURN} model-selected workflow skills; continue with the active set or ask the user to activate another explicitly.`,
        );
      }
      const skill = catalog.loadImplicit(name);
      if (!selectableIds.has(skill.id)) {
        throw new WorkflowSkillError(
          `Error: workflow skill ${JSON.stringify(skill.qualifiedName)} is not in the exposed catalog or recent search results; search for it before activation.`,
        );
      }
      const result = activateSkill(skill, "model_selected", "");
      if (result.newlyActivated) modelSelectedThisTurn += 1;
      return result;
    },
    deactivate: (lookup) => {
      const activation = resolveActive(active(), lookup);
      const index = activeSkillIds.indexOf(activation.descriptorId);
      activeSkillIds.splice(index, 1);
      return copySkillActivation(activation);
    },
    reload: (lookup) => {
      const previous = resolveActive(active(), lookup);
      const skill = catalog.loadPackage(previous.packageId);
      if (skill === undefined) {
        throw new WorkflowSkillError(
          `Error: workflow skill ${JSON.stringify(previous.qualifiedName)} is missing on disk and cannot be reloaded.`,
        );
      }
      if (
        skill.id === previous.descriptorId &&
        skill.content === previous.contentSnapshot &&
        skill.resourcePaths.length === previous.resourcePaths.length &&
        skill.resourcePaths.every(
          (path, index) => path === previous.resourcePaths[index],
        )
      ) {
        return {
          activation: copySkillActivation(previous),
          skill: workflowSkillFromActivation(previous),
          newlyActivated: false,
        };
      }
      const activeIndex = activeSkillIds.indexOf(previous.descriptorId);
      const activation = skillActivationFromWorkflowSkill({
        skill,
        trigger: "user_explicit",
        args: previous.args,
        activatedAt: now(),
      });
      activations.push(activation);
      activeSkillIds.splice(activeIndex, 1, activation.descriptorId);
      return {
        activation: copySkillActivation(activation),
        skill: workflowSkillFromActivation(activation),
        newlyActivated: true,
        record: activationRecord(activation),
      };
    },
    active,
    activeStatuses: () =>
      active().map((activation): ActiveSkillStatus => {
        let current: WorkflowSkill | undefined;
        let unavailableStatus: ActiveSkillStatus["diskStatus"] =
          "missing_on_disk";
        try {
          current = catalog.loadPackage(activation.packageId);
        } catch (error) {
          if (!(error instanceof WorkflowSkillError)) throw error;
          if (!error.message.endsWith("was not found.")) {
            unavailableStatus = "changed_on_disk";
          }
        }
        return {
          activation: copySkillActivation(activation),
          diskStatus:
            current === undefined
              ? unavailableStatus
              : current.digest === activation.digest
                ? "current"
                : "changed_on_disk",
        };
      }),
    state,
    restore: (restored) => {
      validateSkillLifecycleState(restored);
      activations.splice(
        0,
        activations.length,
        ...restored.skillActivations.map(copySkillActivation),
      );
      activeSkillIds.splice(
        0,
        activeSkillIds.length,
        ...restored.activeSkillIds,
      );
    },
  };
}
