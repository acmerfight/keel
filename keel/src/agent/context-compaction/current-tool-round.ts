import type { Message } from "../../llm/types.ts";

interface CurrentToolRoundOutput {
  readonly messageIndex: number;
  readonly message: Extract<Message, { readonly role: "tool" }>;
}

interface CurrentToolRound {
  readonly instructionStartIndex: number;
  readonly toolRequestIndex: number;
  readonly toolRequest: Extract<Message, { readonly role: "assistant" }>;
  readonly toolOutputs: readonly CurrentToolRoundOutput[];
}

function currentToolRoundInstructionStartIndex(
  messages: readonly Message[],
  toolRequestIndex: number,
): number {
  for (
    let messageIndex = toolRequestIndex - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    if (messages[messageIndex]?.role === "user") {
      return messageIndex;
    }
  }
  return toolRequestIndex;
}

export function currentToolRound(
  messages: readonly Message[],
): CurrentToolRound | null {
  const toolRequestIndex = messages.findLastIndex(
    (message) => message.role === "assistant",
  );
  const toolRequest = messages[toolRequestIndex];
  if (toolRequest?.role !== "assistant" || toolRequest.toolCalls.length === 0) {
    return null;
  }

  const toolOutputs: CurrentToolRoundOutput[] = [];
  for (
    let messageIndex = toolRequestIndex + 1;
    messageIndex < messages.length;
    messageIndex++
  ) {
    const message = messages[messageIndex];
    if (message?.role !== "tool") {
      break;
    }
    toolOutputs.push({ messageIndex, message });
  }
  if (toolOutputs.length === 0) {
    return null;
  }

  return {
    instructionStartIndex: currentToolRoundInstructionStartIndex(
      messages,
      toolRequestIndex,
    ),
    toolRequestIndex,
    toolRequest,
    toolOutputs,
  };
}
