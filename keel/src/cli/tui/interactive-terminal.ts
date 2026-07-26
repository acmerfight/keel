import { EventEmitter } from "node:events";
import {
  CombinedAutocompleteProvider,
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  type SlashCommand,
  type Terminal,
  Text,
  TUI,
} from "@earendil-works/pi-tui";
import type { SkillDescriptor } from "../../skills/model.ts";
import type { StableInteractiveDisplayOptions } from "../interactive-session/display.ts";
import type { InteractiveLineInput } from "../interactive-session/line-reader.ts";
import type {
  InteractiveComposerMode,
  InteractiveInputDisposition,
} from "../interactive-session/types.ts";
import type { InteractiveTranscriptEvent } from "../output.ts";
import {
  createInteractiveTerminalTheme,
  type InteractiveTerminalColorMode,
  type InteractiveTerminalTheme,
  InteractiveTranscript,
} from "./interactive-transcript.ts";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function editorTheme(theme: InteractiveTerminalTheme): EditorTheme {
  return {
    borderColor: theme.accent,
    selectList: {
      selectedPrefix: theme.accent,
      selectedText: theme.accentStrong,
      description: theme.muted,
      scrollInfo: theme.muted,
      noMatch: theme.warning,
    },
  };
}

class TerminalLineInput extends EventEmitter implements InteractiveLineInput {
  private closed = false;

  readonly submit = (line: string): void => {
    this.emit("line", line);
  };

  readonly close = (): void => {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close");
  };
}

export interface InteractiveTerminalDisplay {
  readonly writeIntro: () => void;
  readonly renderPrompt: () => void;
  readonly acceptInput: () => void;
  readonly closePrompt: () => void;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly lineInput: InteractiveLineInput;
  readonly renderSubmittedInput: (
    value: string,
    disposition: InteractiveInputDisposition,
  ) => void;
  readonly renderAgentEvent: (event: InteractiveTranscriptEvent) => void;
  readonly setActivityStatus: (text: string | null) => void;
  readonly setGoalStatus: (text: string | null) => void;
  readonly setComposerMode: (mode: InteractiveComposerMode) => void;
  readonly start: () => void;
  readonly stop: () => void;
}

type ComposerHistoryState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "browsing";
      readonly current: string;
      readonly newer: readonly string[];
      readonly older: readonly string[];
      readonly draft: {
        readonly text: string;
        readonly cursorColumn: number;
      };
    };

export function createInteractiveTerminalDisplay(
  terminal: Terminal,
  options: StableInteractiveDisplayOptions & {
    readonly colorMode: InteractiveTerminalColorMode;
    readonly onInterrupt: () => void;
    readonly workspace?: string;
    readonly skillCompletions?: readonly SkillDescriptor[];
  },
): InteractiveTerminalDisplay {
  const tui = new TUI(terminal, true);
  const theme = createInteractiveTerminalTheme(options.colorMode);
  const transcript = new InteractiveTranscript(theme);
  const activityStatus = new Text("", 0, 0);
  const goalStatus = new Text("", 0, 0);
  const prompt = new Text(theme.accentStrong("keel>"), 0, 0);
  const editor = new Editor(tui, editorTheme(theme));
  const commands: SlashCommand[] = [
    { name: "help", description: "Show interactive help." },
    { name: "undo", description: "Restore an undo checkpoint." },
    { name: "model", description: "Show or switch the active model." },
    {
      name: "skill",
      description: "Show or activate workflow skills.",
      argumentHint: "<name|scope:name|scope:root-id:name> [task]",
      getArgumentCompletions: (prefix) => {
        const normalizedPrefix = prefix.trimStart().toLowerCase();
        if (normalizedPrefix.includes(" ")) return null;
        return (options.skillCompletions ?? [])
          .filter((skill) =>
            skill.qualifiedName.toLowerCase().includes(normalizedPrefix),
          )
          .map((skill) => ({
            value: skill.qualifiedName,
            label: skill.qualifiedName,
            description: skill.description,
          }));
      },
    },
    { name: "status", description: "Show current session state." },
    { name: "title", description: "Show or set the session title." },
    { name: "goal", description: "Show or update the session goal." },
    { name: "tasks", description: "Show current task progress." },
    { name: "diff", description: "Show current git changes." },
    { name: "approvals", description: "Manage active Bash approvals." },
    { name: "compact", description: "Compact older conversation context." },
    { name: "fork", description: "Fork the saved session." },
    { name: "fork-points", description: "List valid session fork points." },
  ];
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(commands, options.workspace ?? "."),
  );
  const composerHint = new Text("", 0, 0);
  const lineInput = new TerminalLineInput();
  let started = false;
  let stopped = false;
  const history: string[] = [];
  let historyState: ComposerHistoryState = { kind: "idle" };
  let composerMode: InteractiveComposerMode = "ready";

  const requestRender = (): void => {
    if (started) {
      tui.requestRender();
    }
  };

  editor.onSubmit = (value) => {
    if (value === "" && composerMode !== "approval") {
      return;
    }
    if (
      composerMode !== "approval" &&
      value !== "" &&
      history.at(0) !== value
    ) {
      history.unshift(value);
      history.splice(100);
    }
    historyState = { kind: "idle" };
    lineInput.submit(value);
  };

  const showHistoryEntry = (value: string): void => {
    editor.setText(value);
    tui.requestRender();
  };

  const restoreHistoryDraft = (draft: {
    readonly text: string;
    readonly cursorColumn: number;
  }): void => {
    editor.setText(draft.text);
    for (const _segment of graphemeSegmenter.segment(
      draft.text.slice(draft.cursorColumn),
    )) {
      editor.handleInput("\x1b[D");
    }
    tui.requestRender();
  };

  tui.addChild(transcript);
  tui.addChild(activityStatus);
  tui.addChild(goalStatus);
  tui.addChild(prompt);
  tui.addChild(editor);
  tui.addChild(composerHint);
  tui.setFocus(editor);
  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      options.onInterrupt();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("d")) && editor.getText() === "") {
      lineInput.close();
      return { consume: true };
    }
    if (
      matchesKey(data, Key.up) &&
      (historyState.kind === "browsing" || editor.getLines().length === 1)
    ) {
      if (historyState.kind === "idle") {
        const [latest, ...older] = history;
        if (latest === undefined) {
          return undefined;
        }
        historyState = {
          kind: "browsing",
          current: latest,
          newer: [],
          older,
          draft: {
            text: editor.getText(),
            cursorColumn: editor.getCursor().col,
          },
        };
      } else {
        const [next, ...older] = historyState.older;
        if (next === undefined) {
          return { consume: true };
        }
        historyState = {
          ...historyState,
          current: next,
          newer: [historyState.current, ...historyState.newer],
          older,
        };
      }
      showHistoryEntry(historyState.current);
      return { consume: true };
    }
    if (matchesKey(data, Key.down) && historyState.kind === "browsing") {
      const [next, ...newer] = historyState.newer;
      if (next === undefined) {
        const draft = historyState.draft;
        historyState = { kind: "idle" };
        restoreHistoryDraft(draft);
      } else {
        historyState = {
          ...historyState,
          current: next,
          newer,
          older: [historyState.current, ...historyState.older],
        };
        showHistoryEntry(historyState.current);
      }
      return { consume: true };
    }
    if (historyState.kind === "browsing") {
      historyState = { kind: "idle" };
    }
    return undefined;
  });

  const stop = (): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    lineInput.close();
    tui.stop();
  };

  const setComposerMode = (mode: InteractiveComposerMode): void => {
    composerMode = mode;
    switch (mode) {
      case "approval":
        prompt.setText(theme.warning("approve>"));
        editor.borderColor = theme.warning;
        composerHint.setText(
          theme.warning("Answer the approval prompt; any other input denies."),
        );
        break;
      case "queue":
        prompt.setText(theme.warning("queue>"));
        editor.borderColor = theme.warning;
        composerHint.setText(
          theme.muted("Runs after the current operation finishes."),
        );
        break;
      case "ready":
        prompt.setText(theme.accentStrong("keel>"));
        editor.borderColor = theme.accent;
        composerHint.setText("");
        break;
      case "steer":
        prompt.setText(theme.warning("steer/next>"));
        editor.borderColor = theme.warning;
        composerHint.setText(
          theme.muted(
            "Steers at the next tool boundary, or runs next if the turn finishes.",
          ),
        );
        break;
    }
    requestRender();
  };

  return {
    lineInput,
    renderSubmittedInput: (value, disposition) => {
      transcript.appendSubmittedInput(value, disposition);
      requestRender();
    },
    renderAgentEvent: (event) => {
      transcript.renderAgentEvent(event);
      requestRender();
    },
    setActivityStatus: (text) => {
      activityStatus.setText(
        text === null ? "" : `${theme.accent("◦")} ${theme.muted(text)}`,
      );
      requestRender();
    },
    setGoalStatus: (text) => {
      goalStatus.setText(
        text === null ? "" : `${theme.warning("◎")} ${theme.muted(text)}`,
      );
      requestRender();
    },
    setComposerMode,
    start: () => {
      started = true;
      tui.start();
    },
    stop,
    writeIntro: () => {
      transcript.writeIntro(options.session);
    },
    renderPrompt: () => {},
    acceptInput: () => {},
    closePrompt: () => {},
    writeStdout: (text) => {
      transcript.appendPlain(text);
      requestRender();
    },
    writeStderr: (text) => {
      transcript.appendPlain(text);
      requestRender();
    },
  };
}
