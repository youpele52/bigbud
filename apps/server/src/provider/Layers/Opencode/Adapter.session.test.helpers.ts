import type { PermissionRuleset } from "@opencode-ai/sdk/v2";

export const APPROVAL_REQUIRED_RULES: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "ask" },
  { permission: "bash", pattern: "*", action: "ask" },
  { permission: "edit", pattern: "*", action: "ask" },
  { permission: "webfetch", pattern: "*", action: "ask" },
  { permission: "websearch", pattern: "*", action: "ask" },
  { permission: "codesearch", pattern: "*", action: "ask" },
  { permission: "external_directory", pattern: "*", action: "ask" },
  { permission: "doom_loop", pattern: "*", action: "ask" },
  { permission: "question", pattern: "*", action: "allow" },
];

export const AUTO_ACCEPT_EDITS_RULES: PermissionRuleset = [
  ...APPROVAL_REQUIRED_RULES,
  { permission: "edit", pattern: "*", action: "allow" },
];

export const FULL_ACCESS_RULES: PermissionRuleset = [
  { permission: "*", pattern: "*", action: "allow" },
];

function makeEmptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: true, value: undefined as T };
        },
      };
    },
  };
}

export function makeMockOpencodeClient(input?: {
  readonly onSessionCreate?: (sessionInput: Record<string, unknown>) => void;
  readonly onMcpAdd?: (mcpInput: Record<string, unknown>) => void;
  readonly onMcpConnect?: (mcpInput: Record<string, unknown>) => void;
  readonly onMcpDisconnect?: (mcpInput: Record<string, unknown>) => void;
  readonly onToolIds?: () => void;
}) {
  return {
    session: {
      create: async (sessionInput: Record<string, unknown>) => {
        input?.onSessionCreate?.(sessionInput);
        return {
          data: {
            id: "opencode-session-1",
          },
          error: undefined,
        };
      },
    },
    event: {
      subscribe: async () => ({
        stream: makeEmptyAsyncIterable<unknown>(),
      }),
    },
    mcp: {
      add: async (mcpInput: Record<string, unknown>) => {
        input?.onMcpAdd?.(mcpInput);
        return { data: {}, error: undefined };
      },
      connect: async (mcpInput: Record<string, unknown>) => {
        input?.onMcpConnect?.(mcpInput);
        return { data: {}, error: undefined };
      },
      disconnect: async (mcpInput: Record<string, unknown>) => {
        input?.onMcpDisconnect?.(mcpInput);
        return { data: {}, error: undefined };
      },
    },
    tool: {
      ids: async () => {
        input?.onToolIds?.();
        return {
          data: [
            "bash",
            "read",
            "bigbud_orchestration_thread-opencode-session-test_rename_thread",
            "bigbud_orchestration_thread-opencode-session-test_archive_thread",
            "bigbud_orchestration_other-thread_rename_thread",
          ],
          error: undefined,
        };
      },
    },
  } as never;
}
