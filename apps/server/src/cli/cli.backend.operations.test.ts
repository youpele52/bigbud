import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@bigbud/shared/Net";
import { expect, it, vi } from "vitest";
import { runBackendNativeCli, type BackendNativeAction } from "./cli.backend.operations.ts";
import { runLocalSupervisorCommand } from "../remote-backend/localSupervisorControl.runner.ts";

vi.mock("../remote-backend/localSupervisorControl.runner.ts", () => ({
  runLocalSupervisorCommand: vi.fn(),
}));

it.each(["enable-linger", "start-rust", "reenable", "toString"])(
  "refuses unlisted native action %s before any account IO",
  async (action) => {
    const exit = await Effect.runPromiseExit(
      runBackendNativeCli({
        authorityId: "a".repeat(32),
        action: action as BackendNativeAction,
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(runLocalSupervisorCommand).not.toHaveBeenCalled();
  },
);
