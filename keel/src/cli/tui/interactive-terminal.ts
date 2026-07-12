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
import type {
  StableInteractiveDisplay,
  StableInteractiveDisplayOptions,
} from "../interactive-session/display.ts";
import { formatInteractiveIntro } from "../interactive-session/display.ts";
import type { InteractiveLineInput } from "../interactive-session/line-reader.ts";
import type {
  InteractiveComposerMode,
  InteractiveInputDisposition,
} from "../interactive-session/types.ts";

const plainText = (text: string): string => text;
const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

const EDITOR_THEME: EditorTheme = {
  borderColor: plainText,
  selectList: {
    selectedPrefix: plainText,
    selectedText: plainText,
    description: plainText,
    scrollInfo: plainText,
    noMatch: plainText,
  },
};

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

export interface InteractiveTerminalDisplay extends StableInteractiveDisplay {
  readonly lineInput: InteractiveLineInput;
  readonly renderSubmittedInput: (
    value: string,
    disposition: InteractiveInputDisposition,
  ) => void;
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

function formatSubmittedInput(
  value: string,
  label: InteractiveInputDisposition,
): string {
  const continuationPrefix = " ".repeat(label.length + 1);
  return value
    .split("\n")
    .map(
      (line, index) =>
        `${index === 0 ? `${label}>` : continuationPrefix} ${line}`,
    )
    .join("\n");
}

export function createInteractiveTerminalDisplay(
  terminal: Terminal,
  options: StableInteractiveDisplayOptions & {
    readonly onInterrupt: () => void;
    readonly workspace?: string;
    readonly skillCompletions?: readonly SkillDescriptor[];
  },
): InteractiveTerminalDisplay {
  const tui = new TUI(terminal, true);
  const transcript = new Text();
  const activityStatus = new Text();
  const goalStatus = new Text();
  const prompt = new Text("keel>");
  const editor = new Editor(tui, EDITOR_THEME);
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
  const composerHint = new Text();
  const lineInput = new TerminalLineInput();
  let transcriptText = "";
  let started = false;
  let stopped = false;
  const history: string[] = [];
  let historyState: ComposerHistoryState = { kind: "idle" };
  let composerMode: InteractiveComposerMode = "ready";

  const append = (text: string): void => {
    transcriptText += text;
    transcript.setText(transcriptText);
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
        prompt.setText("approve>");
        composerHint.setText(
          "Answer the approval prompt; any other input denies.",
        );
        break;
      case "queue":
        prompt.setText("queue>");
        composerHint.setText(
          "Input runs after the current operation finishes.",
        );
        break;
      case "ready":
        prompt.setText("keel>");
        composerHint.setText("");
        break;
      case "steer":
        prompt.setText("steer/next>");
        composerHint.setText(
          "Steers at the next tool boundary; if this turn finishes first, it runs next. /commands run after the turn.",
        );
        break;
    }
    if (started) {
      tui.requestRender();
    }
  };

  return {
    lineInput,
    renderSubmittedInput: (value, disposition) => {
      append(`${formatSubmittedInput(value, disposition)}\n`);
    },
    setActivityStatus: (text) => {
      activityStatus.setText(text === null ? "" : `activity: ${text}`);
      if (started) tui.requestRender();
    },
    setGoalStatus: (text) => {
      goalStatus.setText(text === null ? "" : `goal · ${text}`);
      if (started) tui.requestRender();
    },
    setComposerMode,
    start: () => {
      started = true;
      tui.start();
    },
    stop,
    writeIntro: () => {
      append(formatInteractiveIntro(options.session));
    },
    renderPrompt: () => {},
    acceptInput: () => {},
    closePrompt: () => {},
    writeStdout: append,
    writeStderr: append,
    writeAssistantHeader: () => {
      append("assistant:\n");
    },
    writeStatusLine: (text) => {
      append(`status: ${text}\n`);
    },
  };
}
