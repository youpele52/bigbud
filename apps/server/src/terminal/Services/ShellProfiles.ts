import type {
  ShellHostScope,
  TerminalShellProfile,
} from "@bigbud/contracts/workspace/terminalShell.ts";
import type { TerminalWslIdentity } from "@bigbud/contracts/workspace/terminal.wsl.ts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ServiceMap from "effect/ServiceMap";

export class ShellProfileDiscoveryError extends Schema.TaggedErrorClass<ShellProfileDiscoveryError>()(
  "ShellProfileDiscoveryError",
  { reason: Schema.Literals(["probe-failed", "timed-out", "unsupported-target"]) },
) {}

/** Server-resolved target context, never a client-supplied executable or account override. */
export interface ShellProfileTarget {
  readonly executionTargetId: string;
  readonly wslIdentity?: TerminalWslIdentity;
}

export interface ShellProfileInventory {
  readonly host: ShellHostScope;
  readonly profiles: readonly TerminalShellProfile[];
}

export interface ShellProfilesShape {
  /** Bounded, host/account-isolated display cache. Failures are not empty inventories. */
  readonly list: (
    target: ShellProfileTarget,
  ) => Effect.Effect<ShellProfileInventory, ShellProfileDiscoveryError>;
  readonly invalidate: (
    target: ShellProfileTarget,
  ) => Effect.Effect<void, ShellProfileDiscoveryError>;
  /** Always probes the execution host again; never authorizes a launch from display cache. */
  readonly revalidate: (
    target: ShellProfileTarget,
  ) => Effect.Effect<ShellProfileInventory, ShellProfileDiscoveryError>;
}

export class ShellProfiles extends ServiceMap.Service<ShellProfiles, ShellProfilesShape>()(
  "bigbud/terminal/ShellProfiles",
) {}
