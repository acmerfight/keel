import {
  type Component,
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { InteractiveTranscriptEvent } from "../interactive-render-events.ts";
import type { StableInteractiveDisplayOptions } from "../interactive-session/display.ts";
import type { InteractiveInputDisposition } from "../interactive-session/types.ts";

export type InteractiveTerminalColorMode = "ansi" | "plain";

export interface InteractiveTerminalTheme {
  readonly accent: (text: string) => string;
  readonly accentStrong: (text: string) => string;
  readonly error: (text: string) => string;
  readonly markdown: MarkdownTheme;
  readonly muted: (text: string) => string;
  readonly strong: (text: string) => string;
  readonly success: (text: string) => string;
  readonly warning: (text: string) => string;
}

function ansiStyle(
  colorMode: InteractiveTerminalColorMode,
  codes: string,
): (text: string) => string {
  if (colorMode === "plain") {
    return (text) => text;
  }
  return (text) => (text === "" ? "" : `\x1b[${codes}m${text}\x1b[0m`);
}

export function createInteractiveTerminalTheme(
  colorMode: InteractiveTerminalColorMode,
): InteractiveTerminalTheme {
  const accent = ansiStyle(colorMode, "36");
  const accentStrong = ansiStyle(colorMode, "1;36");
  const error = ansiStyle(colorMode, "31");
  const muted = ansiStyle(colorMode, "2");
  const strong = ansiStyle(colorMode, "1");
  const success = ansiStyle(colorMode, "32");
  const warning = ansiStyle(colorMode, "33");
  return {
    accent,
    accentStrong,
    error,
    muted,
    strong,
    success,
    warning,
    markdown: {
      heading: strong,
      link: ansiStyle(colorMode, "4;36"),
      linkUrl: muted,
      code: accent,
      codeBlock: (text) => text,
      codeBlockBorder: muted,
      quote: muted,
      quoteBorder: muted,
      hr: muted,
      listBullet: (text) => accent(text === "- " ? "• " : text),
      bold: strong,
      italic: ansiStyle(colorMode, "3"),
      strikethrough: ansiStyle(colorMode, "9"),
      underline: ansiStyle(colorMode, "4"),
    },
  };
}

class PrefixedComponent implements Component {
  private readonly prefix: string;
  private readonly content: Component;

  constructor(prefix: string, content: Component) {
    this.prefix = prefix;
    this.content = content;
  }

  invalidate(): void {
    this.content.invalidate();
  }

  render(width: number): string[] {
    const prefixWidth = visibleWidth(this.prefix);
    if (width <= prefixWidth) {
      return [truncateToWidth(this.prefix, width)];
    }
    return this.content
      .render(width - prefixWidth)
      .map(
        (line, index) =>
          `${index === 0 ? this.prefix : " ".repeat(prefixWidth)}${line}`,
      );
  }
}

type ToolRowState =
  | { readonly kind: "failed"; readonly label: string }
  | { readonly kind: "interrupted"; readonly label: string }
  | { readonly kind: "running"; readonly label: string }
  | { readonly kind: "succeeded"; readonly label: string };

class ToolRow implements Component {
  private state: ToolRowState;
  private readonly theme: InteractiveTerminalTheme;

  constructor(state: ToolRowState, theme: InteractiveTerminalTheme) {
    this.state = state;
    this.theme = theme;
  }

  update(state: ToolRowState): void {
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    switch (this.state.kind) {
      case "running":
        return [
          truncateToWidth(
            `${this.theme.accent("◦")} ${this.state.label}`,
            width,
          ),
        ];
      case "succeeded":
        return [
          truncateToWidth(
            `${this.theme.success("✓")} ${this.theme.muted(this.state.label)}`,
            width,
          ),
        ];
      case "failed":
        return [
          truncateToWidth(this.theme.error(`✗ ${this.state.label}`), width),
        ];
      case "interrupted":
        return [
          truncateToWidth(
            this.theme.warning(`! ${this.state.label} · interrupted`),
            width,
          ),
        ];
    }
  }
}

class AssistantMessage extends Markdown {
  private content = "";

  append(text: string): void {
    this.content += text;
    this.setText(this.content);
  }
}

function submittedInputBadge(disposition: InteractiveInputDisposition): string {
  switch (disposition) {
    case "approve":
      return "[approval] ";
    case "keel":
      return "";
    case "queue":
      return "[queued] ";
    case "steer/next":
      return "[steer] ";
  }
}

export class InteractiveTranscript extends Container {
  private activeAssistant: AssistantMessage | null = null;
  private readonly activeTools = new Map<string, ToolRow>();
  private readonly theme: InteractiveTerminalTheme;

  constructor(theme: InteractiveTerminalTheme) {
    super();
    this.theme = theme;
  }

  writeIntro(session: StableInteractiveDisplayOptions["session"]): void {
    const identity =
      session.kind === "ephemeral"
        ? `${this.theme.strong("Keel")} ${this.theme.muted("· ephemeral")}`
        : `${this.theme.strong("Keel")} ${this.theme.muted(`· ${session.sessionId}`)}`;
    const persistence =
      session.kind === "ephemeral"
        ? "This session is not saved."
        : session.resumeAvailable
          ? `Resume later with keel --resume ${session.sessionId}`
          : "This session becomes resumable after its first completed turn.";
    this.addChild(
      new Text(
        [
          identity,
          this.theme.muted(persistence),
          this.theme.muted(
            "Keep refining the task here. Type /help for commands.",
          ),
        ].join("\n"),
        0,
        0,
      ),
    );
  }

  appendSubmittedInput(
    value: string,
    disposition: InteractiveInputDisposition,
  ): void {
    this.activeAssistant = null;
    if (this.children.length > 0) {
      this.addChild(new Spacer(1));
    }
    const badge = submittedInputBadge(disposition);
    this.addChild(
      new PrefixedComponent(
        `${this.theme.accentStrong("›")} `,
        new Text(`${this.theme.muted(badge)}${value}`, 0, 0),
      ),
    );
  }

  appendPlain(text: string): void {
    this.activeAssistant = null;
    this.addChild(new Text(text.replace(/\n$/, ""), 0, 0));
  }

  private settleTool(toolCallId: string, state: ToolRowState): void {
    const row = this.activeTools.get(toolCallId);
    if (row === undefined) {
      throw new Error(`Tool ${toolCallId} settled before it started.`);
    }
    row.update(state);
    this.activeTools.delete(toolCallId);
  }

  renderAgentEvent(event: InteractiveTranscriptEvent): void {
    switch (event.type) {
      case "assistant_delta": {
        if (this.activeAssistant === null) {
          this.activeAssistant = new AssistantMessage(
            "",
            0,
            0,
            this.theme.markdown,
          );
          this.addChild(this.activeAssistant);
        }
        this.activeAssistant.append(event.text);
        break;
      }
      case "tool_started": {
        this.activeAssistant = null;
        if (this.activeTools.has(event.toolCallId)) {
          throw new Error(`Tool ${event.toolCallId} started more than once.`);
        }
        const row = new ToolRow(
          { kind: "running", label: event.label },
          this.theme,
        );
        this.activeTools.set(event.toolCallId, row);
        this.addChild(row);
        break;
      }
      case "tool_succeeded":
        this.activeAssistant = null;
        this.settleTool(event.toolCallId, {
          kind: "succeeded",
          label: event.label,
        });
        break;
      case "tool_failed":
        this.activeAssistant = null;
        this.settleTool(event.toolCallId, {
          kind: "failed",
          label: event.label,
        });
        break;
      case "tool_interrupted":
        this.activeAssistant = null;
        this.settleTool(event.toolCallId, {
          kind: "interrupted",
          label: event.label,
        });
        break;
      case "notice": {
        this.activeAssistant = null;
        const marker =
          event.tone === "error"
            ? this.theme.error("✗")
            : event.tone === "warning"
              ? this.theme.warning("!")
              : this.theme.muted("·");
        const content =
          event.tone === "error"
            ? this.theme.error(event.text)
            : event.tone === "warning"
              ? this.theme.warning(event.text)
              : this.theme.muted(event.text);
        this.addChild(
          new PrefixedComponent(`${marker} `, new Text(content, 0, 0)),
        );
        break;
      }
    }
  }
}
