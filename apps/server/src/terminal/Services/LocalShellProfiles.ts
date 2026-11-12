import type { TerminalShellProfile } from "@bigbud/contracts/workspace/terminalShell.ts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ServiceMap from "effect/ServiceMap";

export class LocalShellDiscoveryError extends Schema.TaggedErrorClass<LocalShellDiscoveryError>()(
  "LocalShellDiscoveryError",
  { reason: Schema.Literals(["probe-failed", "timed-out"]) },
) {}

export interface LocalShellProfilesShape {
  /** Display inventory only: successful probes are cached and concurrent reads coalesce. */
  readonly list: Effect.Effect<readonly TerminalShellProfile[], LocalShellDiscoveryError>;
  /** Drop display inventory after a reconnect or explicit refresh. */
  readonly invalidate: Effect.Effect<void>;
  /** Launch preflight must bypass the display cache, including a cached empty inventory. */
  readonly revalidate: Effect.Effect<readonly TerminalShellProfile[], LocalShellDiscoveryError>;
}

/** Deliberately local-only. Never substitute this inventory for SSH, WSL, or agent profiles. */
export class LocalShellProfiles extends ServiceMap.Service<
  LocalShellProfiles,
  LocalShellProfilesShape
>()("bigbud/terminal/LocalShellProfiles") {}
