import type { ShellSelection } from "@bigbud/contracts/workspace/terminalShell.ts";
import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";
import type {
  ResolvedShellProfileLaunch,
  ShellProfileResolutionError,
} from "../Layers/ShellProfiles.launch";
import type { ShellProfileDiscoveryError, ShellProfileTarget } from "./ShellProfiles";

export interface ShellLaunchPlannerShape {
  /**
   * Resolve only against a fresh execution-host inventory. This is a launch plan, not proof
   * of a successful spawn; only the execution backend may publish actual launch identity.
   * Legacy returns null without discovery so existing fallback/reattach paths are unchanged.
   */
  readonly resolveProfile: (input: {
    readonly target: ShellProfileTarget;
    readonly selection: ShellSelection;
  }) => Effect.Effect<
    ResolvedShellProfileLaunch | null,
    ShellProfileDiscoveryError | ShellProfileResolutionError
  >;
}

export class ShellLaunchPlanner extends ServiceMap.Service<
  ShellLaunchPlanner,
  ShellLaunchPlannerShape
>()("bigbud/terminal/ShellLaunchPlanner") {}
