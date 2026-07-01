import { Effect, Stream } from "effect";
import { vi } from "vitest";

import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";

export function createFakeAcpSessionRuntime(): AcpSessionRuntimeShape {
  return {
    handleRequestPermission: vi.fn(() => Effect.void),
    handleElicitation: vi.fn(() => Effect.void),
    handleReadTextFile: vi.fn(() => Effect.void),
    handleWriteTextFile: vi.fn(() => Effect.void),
    handleCreateTerminal: vi.fn(() => Effect.void),
    handleTerminalOutput: vi.fn(() => Effect.void),
    handleTerminalWaitForExit: vi.fn(() => Effect.void),
    handleTerminalKill: vi.fn(() => Effect.void),
    handleTerminalRelease: vi.fn(() => Effect.void),
    handleSessionUpdate: vi.fn(() => Effect.void),
    handleElicitationComplete: vi.fn(() => Effect.void),
    handleUnknownExtRequest: vi.fn(() => Effect.void),
    handleUnknownExtNotification: vi.fn(() => Effect.void),
    handleExtRequest: vi.fn(() => Effect.void),
    handleExtNotification: vi.fn(() => Effect.void),
    start: vi.fn(() =>
      Effect.succeed({
        sessionId: "acp-session-1",
        initializeResult: {} as never,
        sessionSetupResult: {} as never,
        modelConfigId: undefined,
      }),
    ),
    getEvents: () => Stream.empty,
    getModeState: Effect.succeed({
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Default" }],
    }),
    getConfigOptions: Effect.succeed([]),
    prompt: vi.fn(() => Effect.succeed({} as never)),
    cancel: Effect.void,
    setMode: vi.fn(() => Effect.succeed({} as never)),
    setConfigOption: vi.fn(() => Effect.succeed({} as never)),
    setModel: vi.fn(() => Effect.void),
    request: vi.fn(() => Effect.succeed({})),
    notify: vi.fn(() => Effect.void),
  };
}
