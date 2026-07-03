const POST_COMPACTION_READ_TOOL_CALL_ID_PREFIX = "post_compaction_read_";

export function postCompactionReadToolCallId(sequence: number): string {
  return `${POST_COMPACTION_READ_TOOL_CALL_ID_PREFIX}${sequence}`;
}

export function isPostCompactionReadToolCallId(toolCallId: string): boolean {
  return toolCallId.startsWith(POST_COMPACTION_READ_TOOL_CALL_ID_PREFIX);
}
