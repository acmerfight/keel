import type { AgentEvent, CostReport } from "../agent/loop.ts";
import type { ToolCall } from "../llm/types.ts";

interface CliOutputRuntime {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
}

export type EndEvent = Extract<AgentEvent, { readonly type: "end" }>;

function formatUsd(value: number): string {
  return value < 0.0001 ? value.toFixed(6) : value.toFixed(4);
}

const TOOL_LABEL_MAX_LENGTH = 160;

// Shared escape style for model-controlled bytes: control characters become
// visible \xNN (or \n-style) escapes so the terminal never interprets them.
function escapeControlChar(char: string): string {
  switch (char) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  }
}

// Assistant text is model-controlled. Newlines and tabs are legitimate prose
// formatting, but every other C0/C1 control character (ESC, BEL, raw CSI/OSC
// bytes) could drive the terminal: clear the screen, move the cursor over
// earlier output, retitle the window, or write the clipboard via OSC 52.
// Escaping per code unit keeps streamed chunks safe: no sequence can
// straddle a chunk boundary once ESC and C1 bytes are neutralized.
function sanitizeAssistantText(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the point
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
    escapeControlChar,
  );
}

// Labels are paths/patterns/commands, not prose, so beyond C0/C1 controls we
// also escape bidi controls and invisible directional marks (visual
// reordering, Trojan Source class; UAX #9 marks ALM/LRM/RLM included) and
// zero-width characters (invisible path segments). The length cap keeps one
// tool call to exactly one readable stderr line.
function sanitizeToolLabel(label: string): string {
  const escaped = label.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the point
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (char) => {
      const code = char.charCodeAt(0);
      return code <= 0x9f
        ? escapeControlChar(char)
        : `\\u{${code.toString(16)}}`;
    },
  );
  return escaped.length <= TOOL_LABEL_MAX_LENGTH
    ? escaped
    : `${escaped.slice(0, TOOL_LABEL_MAX_LENGTH)}...`;
}

function toolCallLabel(toolCall: ToolCall): string {
  switch (toolCall.tool) {
    case "read":
      return sanitizeToolLabel(`read ${toolCall.path}`);
    case "grep":
      return sanitizeToolLabel(
        toolCall.path === undefined
          ? `grep ${toolCall.pattern}`
          : `grep ${toolCall.pattern} ${toolCall.path}`,
      );
    case "edit":
      return sanitizeToolLabel(`edit ${toolCall.path}`);
    case "write":
      return sanitizeToolLabel(`write ${toolCall.path}`);
    case "bash":
      return sanitizeToolLabel(`bash ${toolCall.command}`);
  }
}

const providerRetryReasonLabels: Readonly<Record<string, string>> = {
  provider_rate_limited: "rate limited",
  provider_server_error: "server error",
  provider_network_error: "network error",
  provider_http_error: "HTTP error",
};

function providerRetryReasonLabel(reason: string): string {
  return providerRetryReasonLabels[reason] ?? "provider error";
}

function contextCompactionReasonLabel(
  reason: Extract<AgentEvent, { readonly type: "context_compacted" }>["reason"],
): string {
  switch (reason) {
    case "proactive":
      return "proactive";
    case "overflow_recovery":
      return "overflow recovery";
  }
}

export function formatCostReport(cost: CostReport, maxUsd: number): string {
  const spent = `$${formatUsd(cost.spentUsd)}`;
  const budget = `$${formatUsd(maxUsd)}`;
  return cost.budgetExceeded
    ? `Cost: ${spent} (budget ${budget} exceeded)\n`
    : `Cost: ${spent} (budget ${budget})\n`;
}

export async function printAgentEvents(
  stream: AsyncIterable<AgentEvent>,
  runtime: CliOutputRuntime,
): Promise<EndEvent | undefined> {
  let finalEnd: EndEvent | undefined;
  for await (const event of stream) {
    if (event.type === "text") {
      runtime.writeStdout(sanitizeAssistantText(event.text));
    } else if (event.type === "context_compacted") {
      runtime.writeStderr(
        `Context compacted: ${contextCompactionReasonLabel(event.reason)} (${event.beforeMessageCount} -> ${event.afterMessageCount} messages, ~${event.beforeEstimatedTokens} -> ~${event.afterEstimatedTokens} tokens)\n`,
      );
    } else if (event.type === "provider_retry") {
      runtime.writeStderr(
        `Provider retry: ${sanitizeToolLabel(event.provider)} ${providerRetryReasonLabel(event.reason)} (attempt ${event.attempt}/${event.maxRetries} in ${Math.round(event.delayMs)}ms)\n`,
      );
    } else if (event.type === "tool_start") {
      runtime.writeStderr(`Tool: ${toolCallLabel(event.toolCall)}\n`);
    } else if (event.type === "tool_end") {
      // Status lives in the line prefix because the label is
      // model-controlled text and could end with a forged failure marker.
      if (!event.ok) {
        runtime.writeStderr(`Tool failed: ${toolCallLabel(event.toolCall)}\n`);
      }
    } else if (event.type === "end") {
      finalEnd = event;
    }
  }
  return finalEnd;
}
