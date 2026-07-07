export function escapeApprovalText(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: approval prompts must render model-controlled bytes visibly.
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2060\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (char) => {
      switch (char) {
        case "\n":
          return "\\n";
        case "\r":
          return "\\r";
        case "\t":
          return "\\t";
        default: {
          const code = char.charCodeAt(0);
          return code <= 0x9f
            ? `\\x${code.toString(16).padStart(2, "0")}`
            : `\\u{${code.toString(16)}}`;
        }
      }
    },
  );
}
