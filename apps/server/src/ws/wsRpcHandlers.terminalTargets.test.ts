import * as Effect from "effect/Effect";
import { WS_METHODS } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";
import { listWslDistributions } from "../terminal/Layers/Manager.wsl.process";
import { makeWsRpcGitTerminalHandlers } from "./wsRpcHandlers.gitTerminal";
import type { WsRpcContext } from "./wsRpcContext";

vi.mock("../terminal/Layers/Manager.wsl.process", () => ({ listWslDistributions: vi.fn() }));

describe("terminal-only distro discovery RPC", () => {
  it.each([
    { supported: false, distributions: [] },
    { supported: true, distributions: ["Ubuntu dev", "Linux-日本語"] },
  ])(
    "returns exact registered names/support status without launching a terminal",
    async (listing) => {
      const open = vi.fn();
      const context = { terminalManager: { open } } as unknown as WsRpcContext;
      vi.mocked(listWslDistributions).mockResolvedValueOnce(listing);
      const handler = makeWsRpcGitTerminalHandlers(context)[WS_METHODS.terminalWslDistributions];
      expect(await Effect.runPromise(handler())).toEqual(listing);
      expect(listWslDistributions).toHaveBeenLastCalledWith(undefined, undefined, {
        signal: expect.any(AbortSignal),
      });
      expect(open).not.toHaveBeenCalled();
    },
  );
  it("returns a typed, redacted discovery failure rather than a default target", async () => {
    vi.mocked(listWslDistributions).mockRejectedValueOnce(
      new Error("private subprocess diagnostic"),
    );
    const handler = makeWsRpcGitTerminalHandlers({} as WsRpcContext)[
      WS_METHODS.terminalWslDistributions
    ];
    await expect(Effect.runPromise(handler())).rejects.toThrow("WSL distribution discovery failed");
  });
});
