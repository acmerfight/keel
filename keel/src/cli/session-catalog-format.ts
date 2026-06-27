import type {
  SessionCatalog,
  SessionCatalogEntry,
  SessionCatalogWarning,
  SessionForkPointRecord,
  SessionForkPolicyRecord,
} from "./session-store.ts";

function sessionCatalogEntryLines(
  entry: SessionCatalogEntry,
  depth: number,
): readonly string[] {
  const indent = "  ".repeat(depth);
  const detailIndent = `${indent}   `;
  return [
    `${indent}${entry.id}  updated ${entry.updatedAt}`,
    `${detailIndent}branch: ${entry.graph.branchTitle}`,
    ...(entry.graph.parentSessionId !== null
      ? [`${detailIndent}parent: ${entry.graph.parentSessionId}`]
      : []),
    ...(entry.workflowSkill !== undefined
      ? [
          `${detailIndent}workflow skill: ${entry.workflowSkill.name} (${entry.workflowSkill.relativePath})`,
        ]
      : []),
    ...(entry.graph.forkPoint !== null
      ? [
          `${detailIndent}fork point: ${formatSessionForkPoint(entry.graph.forkPoint)}`,
        ]
      : []),
    ...(entry.graph.parentSessionId !== null
      ? [
          `${detailIndent}fork policy: ${formatSessionForkPolicy(entry.graph.forkPolicy)}`,
        ]
      : []),
    `${detailIndent}preview: ${entry.preview}`,
    `${detailIndent}resume: keel --resume ${entry.id}`,
    `${detailIndent}fork-points: keel --resume ${entry.id} --fork-points`,
    `${detailIndent}fork: keel sessions fork ${entry.id} <new-id>`,
  ];
}

function formatSessionForkPoint(forkPoint: SessionForkPointRecord): string {
  switch (forkPoint.kind) {
    case "before_message":
      return `before message ${forkPoint.sourceMessageId} (message ${forkPoint.sourceOrdinal}): ${forkPoint.preview}`;
    case "end":
      return forkPoint.sourceLastMessageId === null
        ? `full restored history from ${forkPoint.sourceSessionId} (0 messages)`
        : `full restored history from ${forkPoint.sourceSessionId} through message ${forkPoint.sourceLastMessageId} (message ${forkPoint.sourceOrdinal})`;
  }
}

function formatSessionForkPolicy(policy: SessionForkPolicyRecord): string {
  return `transcript=${policy.transcript}, pendingInputs=${policy.pendingInputs}, queuedInputs=${policy.queuedInputs}, bashApprovalGrants=${policy.bashApprovalGrants}`;
}

interface SessionCatalogGraphGroup {
  readonly graphId: string;
  readonly rootSessionId: string;
  readonly updatedAt: string;
  readonly entries: readonly SessionCatalogEntry[];
}

function compareSessionCatalogGraphGroups(
  left: SessionCatalogGraphGroup,
  right: SessionCatalogGraphGroup,
): number {
  const timestampDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return left.graphId.localeCompare(right.graphId);
}

function sessionCatalogGraphGroups(
  entries: readonly SessionCatalogEntry[],
): readonly SessionCatalogGraphGroup[] {
  const groupsById = new Map<string, SessionCatalogGraphGroup>();
  for (const entry of [...entries].sort(
    compareSessionCatalogEntriesForFormat,
  )) {
    const group = groupsById.get(entry.graph.graphId);
    if (group === undefined) {
      groupsById.set(entry.graph.graphId, {
        graphId: entry.graph.graphId,
        rootSessionId: entry.graph.rootSessionId,
        updatedAt: entry.updatedAt,
        entries: [entry],
      });
      continue;
    }
    groupsById.set(entry.graph.graphId, {
      graphId: group.graphId,
      rootSessionId: group.rootSessionId,
      updatedAt: group.updatedAt,
      entries: [...group.entries, entry],
    });
  }

  return [...groupsById.values()].sort(compareSessionCatalogGraphGroups);
}

function sessionCatalogTreeLines(
  entries: readonly SessionCatalogEntry[],
): readonly string[] {
  const entryIds = new Set(entries.map((entry) => entry.id));
  const childrenByParent = new Map<string, SessionCatalogEntry[]>();
  const roots: SessionCatalogEntry[] = [];
  for (const entry of entries) {
    const parentSessionId = entry.graph.parentSessionId;
    if (parentSessionId === null || !entryIds.has(parentSessionId)) {
      roots.push(entry);
      continue;
    }
    const children = childrenByParent.get(parentSessionId) ?? [];
    children.push(entry);
    childrenByParent.set(parentSessionId, children);
  }

  const lines: string[] = [];
  const appendEntry = (entry: SessionCatalogEntry, depth: number): void => {
    lines.push(...sessionCatalogEntryLines(entry, depth));
    for (const child of (childrenByParent.get(entry.id) ?? []).sort(
      compareSessionCatalogEntriesForFormat,
    )) {
      appendEntry(child, depth + 1);
    }
  };
  for (const root of roots.sort(compareSessionCatalogEntriesForFormat)) {
    appendEntry(root, 0);
  }
  return lines;
}

function compareSessionCatalogEntriesForFormat(
  left: SessionCatalogEntry,
  right: SessionCatalogEntry,
): number {
  const timestampDelta = right.updatedAt.localeCompare(left.updatedAt);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }
  return left.id.localeCompare(right.id);
}

export function formatSessionCatalog(catalog: SessionCatalog): string {
  if (catalog.sessions.length === 0) {
    return `No sessions for workspace ${catalog.workspace}.\n`;
  }
  const lines = [`Sessions for workspace ${catalog.workspace}:`];
  for (const group of sessionCatalogGraphGroups(catalog.sessions)) {
    lines.push(
      `graph ${group.graphId} root ${group.rootSessionId}  updated ${group.updatedAt}`,
    );
    lines.push(...sessionCatalogTreeLines(group.entries));
  }
  return `${lines.join("\n")}\n`;
}

export function formatSessionCatalogWarnings(
  warnings: readonly SessionCatalogWarning[],
): string {
  return warnings
    .map(
      (warning) =>
        `Warning: skipped session "${warning.sessionId}": ${warning.message}\n`,
    )
    .join("");
}

export function formatSessionForkCreated(options: {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly forkBeforeMessage?: string;
}): string {
  const forkLine =
    options.forkBeforeMessage === undefined
      ? `Forked session "${options.sourceSessionId}" to "${options.targetSessionId}".`
      : `Forked session "${options.sourceSessionId}" to "${options.targetSessionId}" before message ${options.forkBeforeMessage}.`;
  return `${forkLine}\nresume: keel --resume ${options.targetSessionId}\n`;
}
