import { Effect } from "effect";

import { stagePackagedDesktopSupervisor } from "./desktopSupervisor.ts";
import { type BuildArch, type BuildPlatform } from "./shared.ts";
import { stagePackagedWorkspaceAgent } from "./workspaceAgent.ts";

export const stageDesktopNativeSidecars = Effect.fn("stageDesktopNativeSidecars")(
  function* (input: {
    readonly repoRoot: string;
    readonly stageServerDir: string;
    readonly platform: typeof BuildPlatform.Type;
    readonly arch: typeof BuildArch.Type;
    readonly skipBuild: boolean;
    readonly verbose: boolean;
  }) {
    yield* stagePackagedWorkspaceAgent(input);
    yield* stagePackagedDesktopSupervisor(input);
  },
);
