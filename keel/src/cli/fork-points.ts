import type { Message } from "../llm/types.ts";
import { sanitizeStatusLineText } from "./output.ts";

export interface SessionForkPoint {
  readonly beforeUser: number;
  readonly preview: string;
}

export interface SessionForkPoints {
  readonly sessionId: string;
  readonly points: readonly SessionForkPoint[];
}

const FORK_POINT_PREVIEW_MAX_LENGTH = 120;

function forkPointPreview(content: string): string {
  const normalized = content.replace(/\s+/gu, " ").trim();
  const sanitized = sanitizeStatusLineText(normalized);
  if (sanitized.length <= FORK_POINT_PREVIEW_MAX_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, FORK_POINT_PREVIEW_MAX_LENGTH - 3)}...`;
}

export function sessionForkPointsFromMessages(options: {
  readonly sessionId: string;
  readonly messages: readonly Message[];
}): SessionForkPoints {
  const points: SessionForkPoint[] = [];
  for (const message of options.messages) {
    if (message.role !== "user") {
      continue;
    }
    const beforeUser = points.length + 1;
    points.push({
      beforeUser,
      preview: forkPointPreview(message.content),
    });
  }
  return {
    sessionId: options.sessionId,
    points,
  };
}

export function formatExternalSessionForkPoints(
  forkPoints: SessionForkPoints,
): string {
  if (forkPoints.points.length === 0) {
    return `No restored user messages in session "${forkPoints.sessionId}".\n`;
  }

  const lines = [`Fork points for session "${forkPoints.sessionId}":`];
  for (const point of forkPoints.points) {
    lines.push(`${point.beforeUser}. ${point.preview}`);
    lines.push(
      `   use: keel sessions fork ${forkPoints.sessionId} <new-id> --before-user ${point.beforeUser}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatInteractiveSessionForkPoints(
  forkPoints: SessionForkPoints,
): string {
  if (forkPoints.points.length === 0) {
    return `No restored user messages in session "${forkPoints.sessionId}".\n`;
  }

  const lines = [`Fork points for session "${forkPoints.sessionId}":`];
  for (const point of forkPoints.points) {
    lines.push(
      `${point.beforeUser}. before user message ${point.beforeUser}: ${point.preview}`,
    );
    lines.push(`   use: /fork <new-id> --before-user ${point.beforeUser}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatInteractiveForkPicker(
  forkPoints: SessionForkPoints,
): string {
  const maxChoice = forkPoints.points.length;
  const lines = [
    `Fork points for session "${forkPoints.sessionId}":`,
    "0. full restored history",
  ];
  for (const point of forkPoints.points) {
    lines.push(
      `${point.beforeUser}. before user message ${point.beforeUser}: ${point.preview}`,
    );
  }
  lines.push("");
  lines.push(`Select fork point [0-${maxChoice}], or q to cancel:`);
  return `${lines.join("\n")}\n`;
}
