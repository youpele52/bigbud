import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type { CursorSettings } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { AcpSessionRuntime } from "../../acp/AcpSessionRuntime.ts";
import { buildCursorAcpSpawnInput } from "../../acp/CursorAcpSupport.ts";
import { buildCursorDiscoveredModelsFromConfigOptions } from "./Provider.config.ts";
import { CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES } from "./Provider.shared.ts";

const makeCursorAcpProbeRuntime = (cursorSettings: CursorSettings) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const probeCwd = yield* Effect.acquireRelease(
      Effect.sync(() =>
        nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "bigbud-cursor-provider-probe-")),
      ),
      (directory) => Effect.sync(() => nodeFs.rmSync(directory, { recursive: true, force: true })),
    );
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: buildCursorAcpSpawnInput(cursorSettings, probeCwd),
        cwd: probeCwd,
        clientInfo: { name: "bigcode-provider-probe", version: "0.0.0" },
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

const withCursorAcpProbeRuntime = <A, E, R>(
  cursorSettings: CursorSettings,
  useRuntime: (acp: AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
) => makeCursorAcpProbeRuntime(cursorSettings).pipe(Effect.flatMap(useRuntime), Effect.scoped);

export const discoverCursorModelsViaAcp = (cursorSettings: CursorSettings) =>
  withCursorAcpProbeRuntime(cursorSettings, (acp) =>
    Effect.map(acp.start(), (started) =>
      buildCursorDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
    ),
  );
