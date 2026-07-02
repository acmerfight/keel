export interface ToolResult {
  readonly content: string;
  readonly sourceTruncated?: boolean;
  readonly artifactContent?: string;
  readonly artifactSourceTruncated?: boolean;
}
