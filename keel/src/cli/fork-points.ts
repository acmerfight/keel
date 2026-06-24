import { sanitizeStatusLineText } from "./output.ts";
import type { StoredMessage } from "./session-store.ts";

interface SessionForkPoint {
  readonly choice: number;
  readonly messageId: string;
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

export function sessionForkPointsFromStoredMessages(options: {
  readonly sessionId: string;
  readonly storedMessages: readonly StoredMessage[];
}): SessionForkPoints {
  const points: SessionForkPoint[] = [];
  for (const storedMessage of options.storedMessages) {
    if (storedMessage.message.role !== "user") {
      continue;
    }
    points.push({
      choice: points.length + 1,
      messageId: storedMessage.id,
      preview: forkPointPreview(storedMessage.message.content),
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
    lines.push(`${point.choice}. message ${point.messageId}: ${point.preview}`);
    lines.push(
      `   use: keel sessions fork ${forkPoints.sessionId} <new-id> --before-message ${point.messageId}`,
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
      `${point.choice}. before message ${point.messageId}: ${point.preview}`,
    );
    lines.push(`   use: /fork <new-id> --before-message ${point.messageId}`);
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
      `${point.choice}. before message ${point.messageId}: ${point.preview}`,
    );
  }
  lines.push("");
  lines.push(`Select fork point [0-${maxChoice}], or q to cancel:`);
  return `${lines.join("\n")}\n`;
}
