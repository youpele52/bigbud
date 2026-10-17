import path from "node:path";
import { homedir } from "node:os";
import type { OpencodeV2Client } from "./Client.ts";
import { v2Request } from "./Client.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import {
  verifyV2NativeEligibility,
  verifyV2NativeReadOnlyEligibility,
  type V2NativeEligibilityVerifier,
} from "./NativeCompatibility.runtime.ts";
import {
  validateV2NativeConfigSources,
  projectV2NativeConfigSources,
} from "./NativeCompatibility.sources.ts";

export interface V2PluginSetupAuthority {
  readonly publication?: {
    /** Separate admission-only authority: exact signed metadata maintenance, never native publication. */
    readonly identityRevalidation?: NonNullable<V2PluginSetupAuthority["publication"]>;
    readonly prepare: () => Promise<void>;
    readonly locked: () => Promise<() => void>;
    readonly beforeMutation: () => Promise<void>;
    readonly assertGate: () => void;
    readonly mutationIssued?: () => void;
    readonly observePhysical?: (operation: Promise<unknown>) => void;
    readonly joinPhysical?: () => Promise<void>;
    readonly joinPhysicalOnCancel: true;
  };
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly scopeKey?: string;
  readonly waiterSignal?: AbortSignal | undefined;
}

/** Config placement never participates in chat/worktree or shared-service identity resolution. */
export function resolveV2PluginConfigRoot(override?: string, env: NodeJS.ProcessEnv = process.env) {
  const root =
    override?.trim() ||
    env.OPENCODE_CONFIG_DIR ||
    path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config"), "opencode");
  if (
    !path.isAbsolute(root) ||
    root.includes("\0") ||
    Buffer.byteLength(root) > 4096 ||
    path.resolve(root) === path.parse(root).root
  )
    throw new Error("V2 automatic plugin configuration root must be an absolute canonical path.");
  return path.resolve(root);
}

/** Public config-source metadata proves the qualified native global scope before any local write. */
export async function readV2PluginConfigScope(
  client: OpencodeV2Client,
  directory: string,
  root: string,
  authority: V2PluginSetupAuthority,
  artifact: V2PluginSetupArtifact,
  eligibility: V2NativeEligibilityVerifier = verifyV2NativeEligibility,
) {
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  const proof = await verifyV2NativeReadOnlyEligibility(
    artifact,
    client,
    directory,
    root,
    authority.signal,
    eligibility,
  );
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  const entries = await v2Request(
    "required plugin config scope",
    (signal) => client.config.get({ location: { directory } }, { signal }),
    { signal: authority.signal },
  );
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  const machinePaths = validateV2NativeConfigSources(entries, root, proof.semanticProfile);
  return { entries: projectV2NativeConfigSources(entries), machinePaths, proof };
}
