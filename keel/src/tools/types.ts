export interface ToolOutputArtifact {
  readonly content: string;
  readonly sourceTruncated: boolean;
}

export interface ToolResult {
  readonly content: string;
  readonly sourceTruncated?: boolean;
  readonly artifact?: ToolOutputArtifact;
}
