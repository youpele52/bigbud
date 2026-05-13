import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface PiRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiRpcModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly reasoning?: boolean;
}

export interface PiRpcSlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly source?: "extension" | "prompt" | "skill";
  readonly sourceInfo?: {
    readonly path: string;
    readonly source: string;
    readonly scope: "user" | "project" | "temporary";
    readonly origin: "package" | "top-level";
    readonly baseDir?: string;
  };
}

export interface PiRpcSessionState {
  readonly model?: PiRpcModel | null;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
}

export type PiRpcRequestCommand =
  | { readonly type: "get_state" }
  | { readonly type: "get_messages" }
  | { readonly type: "get_available_models" }
  | { readonly type: "get_commands" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: string }
  | {
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | {
      readonly type: "steer";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
    }
  | {
      readonly type: "follow_up";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
    }
  | { readonly type: "abort" };

export type PiRpcWriteOnlyCommand =
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly value: string;
    }
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly confirmed: boolean;
    }
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly cancelled: true;
    };

export type PiRpcCommand = (PiRpcRequestCommand & { readonly id?: string }) | PiRpcWriteOnlyCommand;

export interface PiRpcResponse<TData = unknown> {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: TData;
  readonly error?: string;
}

export type PiRpcAssistantMessageEvent =
  | {
      readonly type: "start";
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "text_start";
      readonly contentIndex: number;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "text_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "text_end";
      readonly contentIndex: number;
      readonly content: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "thinking_start";
      readonly contentIndex: number;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "thinking_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "thinking_end";
      readonly contentIndex: number;
      readonly content: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "toolcall_start";
      readonly contentIndex: number;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "toolcall_delta";
      readonly contentIndex: number;
      readonly delta: string;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "toolcall_end";
      readonly contentIndex: number;
      readonly toolCall: Record<string, unknown>;
      readonly partial?: Record<string, unknown>;
    }
  | {
      readonly type: "done";
      readonly reason: string;
      readonly message: Record<string, unknown>;
    }
  | {
      readonly type: "error";
      readonly reason: string;
      readonly error: Record<string, unknown>;
    };

export type PiRpcExtensionUIRequest =
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "select";
      readonly title: string;
      readonly options: ReadonlyArray<string>;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "confirm";
      readonly title: string;
      readonly message: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "input";
      readonly title: string;
      readonly placeholder?: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "editor";
      readonly title: string;
      readonly prefill?: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "notify";
      readonly message: string;
      readonly notifyType?: "info" | "warning" | "error";
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setStatus";
      readonly statusKey: string;
      readonly statusText: string | undefined;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setWidget";
      readonly widgetKey: string;
      readonly widgetLines: ReadonlyArray<string> | undefined;
      readonly widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setTitle";
      readonly title: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "set_editor_text";
      readonly text: string;
    };

export type PiRpcStdoutEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_end" }
  | {
      readonly type: "turn_start";
      readonly turnIndex?: number;
      readonly timestamp?: number;
    }
  | {
      readonly type: "turn_end";
      readonly turnIndex?: number;
      readonly message?: Record<string, unknown>;
      readonly toolResults?: unknown;
    }
  | {
      readonly type: "message_start";
      readonly message: Record<string, unknown>;
    }
  | {
      readonly type: "message_update";
      readonly message: Record<string, unknown>;
      readonly assistantMessageEvent?: PiRpcAssistantMessageEvent;
    }
  | {
      readonly type: "message_end";
      readonly message: Record<string, unknown>;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: Record<string, unknown>;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: Record<string, unknown>;
      readonly partialResult?: string;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result?: unknown;
      readonly isError?: boolean;
    }
  | PiRpcExtensionUIRequest;

export type PiRpcStdoutMessage = PiRpcResponse | PiRpcStdoutEvent;

export interface PiRpcProcessOptions {
  readonly binaryPath: string;
  readonly cwd?: string;
  readonly sessionFile?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PiRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly stderrTail: () => string;
  readonly request: <TData = unknown>(
    command: PiRpcRequestCommand,
    timeoutMs?: number,
  ) => Promise<PiRpcResponse<TData>>;
  readonly write: (command: PiRpcCommand) => Promise<void>;
  readonly subscribe: (listener: (message: PiRpcStdoutMessage) => void) => () => void;
  readonly stop: () => Promise<void>;
}
