export type InteractiveTranscriptEvent =
  | {
      readonly type: "assistant_delta";
      readonly text: string;
    }
  | {
      readonly type: "tool_started";
      readonly toolCallId: string;
      readonly label: string;
    }
  | {
      readonly type: "tool_succeeded";
      readonly toolCallId: string;
      readonly label: string;
    }
  | {
      readonly type: "tool_failed";
      readonly toolCallId: string;
      readonly label: string;
    }
  | {
      readonly type: "tool_interrupted";
      readonly toolCallId: string;
      readonly label: string;
    }
  | {
      readonly type: "notice";
      readonly tone: "error" | "info" | "warning";
      readonly text: string;
    };
