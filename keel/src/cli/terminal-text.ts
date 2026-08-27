const TOOL_LABEL_MAX_LENGTH = 160;
const STATUS_LINE_TEXT_MAX_LENGTH = 240;

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

function firstCodePoint(character: string): number {
  const firstCodeUnit = character.charCodeAt(0);
  if (firstCodeUnit < 0xd800 || firstCodeUnit > 0xdbff) {
    return firstCodeUnit;
  }
  const secondCodeUnit = character.charCodeAt(1);
  return (firstCodeUnit - 0xd800) * 0x400 + (secondCodeUnit - 0xdc00) + 0x10000;
}

// Assistant text is model-controlled. Newlines and tabs are legitimate prose
// formatting, but every other C0/C1 control character (ESC, BEL, raw CSI/OSC
// bytes) could drive the terminal: clear the screen, move the cursor over
// earlier output, retitle the window, or write the clipboard via OSC 52.
// Escaping per code unit keeps streamed chunks safe: no sequence can
// straddle a chunk boundary once ESC and C1 bytes are neutralized.
export function sanitizeAssistantText(text: string): string {
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
export function sanitizeToolLabel(label: string): string {
  const escaped = label.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex lint/suspicious/noMisleadingCharacterClass: escaping invisible and control characters is the point
    /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0001}\u{e0020}-\u{e007f}]/gu,
    (char) => {
      const code = firstCodePoint(char);
      return code <= 0x9f
        ? escapeControlChar(char)
        : `\\u{${code.toString(16)}}`;
    },
  );
  return escaped.length <= TOOL_LABEL_MAX_LENGTH
    ? escaped
    : `${escaped.slice(0, TOOL_LABEL_MAX_LENGTH)}...`;
}

export function escapeTerminalText(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex lint/suspicious/noMisleadingCharacterClass: status lines must render untrusted invisible and control bytes visibly.
    /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0001}\u{e0020}-\u{e007f}]/gu,
    (char) => {
      const code = firstCodePoint(char);
      return code <= 0x9f
        ? escapeControlChar(char)
        : `\\u{${code.toString(16)}}`;
    },
  );
}

export function sanitizeStatusLineText(text: string): string {
  const escaped = escapeTerminalText(text);
  return escaped.length <= STATUS_LINE_TEXT_MAX_LENGTH
    ? escaped
    : `${escaped.slice(0, STATUS_LINE_TEXT_MAX_LENGTH)}...`;
}
