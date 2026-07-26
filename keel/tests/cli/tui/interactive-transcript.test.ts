import { describe, expect, test } from "vitest";
import {
  createInteractiveTerminalTheme,
  InteractiveTranscript,
} from "../../../src/cli/tui/interactive-transcript.ts";

function renderTranscript(
  transcript: InteractiveTranscript,
  width = 80,
): string {
  return transcript.render(width).join("\n");
}

describe("Interactive Transcript", () => {
  test(`Given ANSI and plain terminals,
    When Keel builds the transcript theme,
    Then semantic accents and Markdown markers remain readable in both modes`, () => {
    const plain = createInteractiveTerminalTheme("plain");
    const ansi = createInteractiveTerminalTheme("ansi");

    expect(plain.accent("read")).toBe("read");
    expect(plain.markdown.codeBlock("const answer = 42;")).toBe(
      "const answer = 42;",
    );
    expect(plain.markdown.listBullet("- ")).toBe("• ");
    expect(plain.markdown.listBullet("2. ")).toBe("2. ");
    expect(ansi.accent("read")).toBe("\u001b[36mread\u001b[0m");
    expect(ansi.accent("")).toBe("");
  });

  test(`Given each session identity and transcript event state,
    When the component renders and reflows its audit trail,
    Then the user can distinguish input, answers, tools, and notices`, () => {
    const theme = createInteractiveTerminalTheme("plain");
    const ephemeral = new InteractiveTranscript(theme);
    ephemeral.writeIntro({ kind: "ephemeral" });
    expect(renderTranscript(ephemeral)).toContain("Keel · ephemeral");
    expect(renderTranscript(ephemeral)).toContain("This session is not saved.");

    const newSaved = new InteractiveTranscript(theme);
    newSaved.writeIntro({
      kind: "saved",
      sessionId: "session-new",
      resumeAvailable: false,
    });
    expect(renderTranscript(newSaved)).toContain("Keel · session-new");
    expect(renderTranscript(newSaved)).toContain(
      "becomes resumable after its first completed turn",
    );

    const resumable = new InteractiveTranscript(theme);
    resumable.writeIntro({
      kind: "saved",
      sessionId: "session-ready",
      resumeAvailable: true,
    });
    expect(renderTranscript(resumable)).toContain(
      "Resume later with keel --resume session-ready",
    );

    const transcript = new InteractiveTranscript(theme);
    transcript.appendSubmittedInput("alpha beta gamma", "keel");
    transcript.invalidate();
    expect(renderTranscript(transcript, 1)).toContain(".");
    expect(renderTranscript(transcript, 12)).toContain("\n  gamma");
    transcript.appendSubmittedInput("guide", "steer/next");
    transcript.appendSubmittedInput("later", "queue");
    transcript.appendSubmittedInput("yes", "approve");
    transcript.appendPlain("local notice\n");

    transcript.renderAgentEvent({ type: "assistant_delta", text: "First " });
    expect(renderTranscript(transcript)).toContain("First");
    transcript.renderAgentEvent({
      type: "assistant_delta",
      text: "answer.",
    });
    expect(renderTranscript(transcript)).toContain("First answer.");

    transcript.renderAgentEvent({
      type: "tool_started",
      toolCallId: "running",
      label: "read running.md",
    });
    expect(renderTranscript(transcript)).toContain("◦ read running.md");

    transcript.renderAgentEvent({
      type: "tool_started",
      toolCallId: "success",
      label: "read success.md",
    });
    transcript.renderAgentEvent({
      type: "tool_succeeded",
      toolCallId: "success",
      label: "read success.md",
    });
    expect(renderTranscript(transcript)).toContain("✓ read success.md");

    transcript.renderAgentEvent({
      type: "tool_started",
      toolCallId: "failure",
      label: "read failure.md",
    });
    transcript.renderAgentEvent({
      type: "tool_failed",
      toolCallId: "failure",
      label: "read failure.md",
    });
    expect(renderTranscript(transcript)).toContain("✗ read failure.md");

    transcript.renderAgentEvent({
      type: "tool_started",
      toolCallId: "interrupted",
      label: "bash sleep 10",
    });
    transcript.renderAgentEvent({
      type: "tool_interrupted",
      toolCallId: "interrupted",
      label: "bash sleep 10",
    });
    expect(renderTranscript(transcript)).toContain(
      "! bash sleep 10 · interrupted",
    );

    transcript.renderAgentEvent({
      type: "notice",
      tone: "info",
      text: "context compacted",
    });
    transcript.renderAgentEvent({
      type: "notice",
      tone: "warning",
      text: "provider retry",
    });
    transcript.renderAgentEvent({
      type: "notice",
      tone: "error",
      text: "artifact failed",
    });
    const rendered = renderTranscript(transcript);
    expect(rendered).toContain("· context compacted");
    expect(rendered).toContain("! provider retry");
    expect(rendered).toContain("✗ artifact failed");
  });

  test(`Given malformed tool lifecycles,
    When a call settles before start or starts twice,
    Then the transcript rejects the ambiguous audit history`, () => {
    const transcript = new InteractiveTranscript(
      createInteractiveTerminalTheme("plain"),
    );

    expect(() =>
      transcript.renderAgentEvent({
        type: "tool_succeeded",
        toolCallId: "missing",
        label: "read missing.md",
      }),
    ).toThrow("Tool missing settled before it started.");

    transcript.renderAgentEvent({
      type: "tool_started",
      toolCallId: "duplicate",
      label: "read duplicate.md",
    });
    expect(() =>
      transcript.renderAgentEvent({
        type: "tool_started",
        toolCallId: "duplicate",
        label: "read duplicate.md",
      }),
    ).toThrow("Tool duplicate started more than once.");
  });
});
