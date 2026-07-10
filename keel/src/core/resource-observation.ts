export interface ReadResourceObservation {
  readonly kind: "read_projection";
  readonly targetPathSha256: string;
  readonly contentSha256: string;
}

export function copyReadResourceObservation(
  observation: ReadResourceObservation,
): ReadResourceObservation {
  return {
    kind: "read_projection",
    targetPathSha256: observation.targetPathSha256,
    contentSha256: observation.contentSha256,
  };
}
