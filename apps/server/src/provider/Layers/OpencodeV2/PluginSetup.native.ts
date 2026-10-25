import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpencodeV2Client } from "./Client.ts";
import { v2Request } from "./Client.ts";
import type { ServerSettingsShape } from "../../../ws/serverSettings.ts";
import type { V2ConsentAuthority } from "./Application.consent.ts";
import { currentV2RequestContext } from "./Client.guard.ts";
import { hasOpencodeV2ManagedPluginTrust } from "@bigbud/shared/opencodeNativeTrust";
import {
  resolveV2PluginConfigRoot,
  readV2PluginConfigScope,
  type V2PluginSetupAuthority,
} from "./PluginSetup.paths.ts";
import { inspectV2PluginControls } from "./PluginSetup.policy.ts";
import { publishV2ManagedPlugin } from "./PluginSetup.publication.ts";
import { v2ManagedPluginFilename, type V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import { verifyV2ThreadTools } from "./Orchestration.readiness.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { readV2CompatibleManualBootstrap } from "./Orchestration.readiness.manual.ts";
import {
  verifyV2NativeEligibility,
  type V2NativeEligibilityVerifier,
} from "./NativeCompatibility.runtime.ts";
import { V2NativeCompatibilityError } from "./NativeCompatibility.types.ts";
import { v2NativeRuntimePlatform } from "./NativeCompatibility.platform.ts";
import { atV2SetupStage } from "./PluginSetup.diagnostics.ts";
import { setupV2NativeFamily } from "./Subagents.setup.ts";

/** Only explicit expanded acknowledgement + an execution context can administer this one managed entry. */
export function makeV2AutomaticPluginSetup(
  settings: ServerSettingsShape,
  _consent: V2ConsentAuthority,
  publication?: V2PluginSetupAuthority["publication"],
  eligibility: V2NativeEligibilityVerifier = verifyV2NativeEligibility,
) {
  return async (
    artifact: V2PluginSetupArtifact,
    client: OpencodeV2Client,
    directory: string,
    signal?: AbortSignal,
  ) => {
    const current = settings.currentSnapshot?.()?.settings.providers.opencodeV2;
    const parent = currentV2RequestContext();
    if (
      !current?.enabled ||
      !hasOpencodeV2ManagedPluginTrust(current) ||
      !parent ||
      parent.intent !== "execute"
    )
      throw new Error(
        "V2 expanded native trust including automatic required-plugin setup must be acknowledged once. Prior host-user trust grants no config-write authority.",
      );
    const root = resolveV2PluginConfigRoot(current.nativePluginConfigRoot);
    signal?.throwIfAborted();
    // Consent owns shared publication; foreground request cancellation never changes another waiter's scope.
    return (async () => {
      const owner = currentV2RequestContext()!;
      const authority: V2PluginSetupAuthority = {
        signal: signal ? AbortSignal.any([owner.permit.signal, signal]) : owner.permit.signal,
        waiterSignal: signal,
        ...(publication ? { publication } : {}),
        scopeKey: JSON.stringify([parent.transport, current.nativeServiceTrust, root]),
        assertCurrent: () => {
          owner.permit.assertCurrent();
          publication?.assertGate();
          const latest = settings.currentSnapshot?.()?.settings.providers.opencodeV2;
          if (
            !latest?.enabled ||
            !hasOpencodeV2ManagedPluginTrust(latest) ||
            resolveV2PluginConfigRoot(latest.nativePluginConfigRoot) !== root
          )
            throw new Error(
              "V2 automatic plugin setup scope changed; late writes/publication rejected.",
            );
        },
      };
      const sources = await atV2SetupStage("config-scope", () =>
        readV2PluginConfigScope(client, directory, root, authority, artifact, eligibility),
      );
      const configured = await atV2SetupStage("config-controls", () =>
        inspectV2PluginControls(
          sources.entries,
          root,
          authority,
          directory,
          sources.machinePaths,
          v2ThreadRegistration(artifact),
        ),
      );
      signal?.throwIfAborted();
      const inventory = await atV2SetupStage("plugin-inventory", () =>
        v2Request(
          "required plugin namespace",
          (signal) => client.plugin.list({ location: { directory } }, { signal }),
          { signal: authority.signal },
        ),
      );
      authority.assertCurrent();
      const matches = inventory.data.filter(
        (plugin) => plugin.id === v2ThreadRegistration(artifact).id,
      );
      if (inventory.data.length > 1000 || matches.length > 1)
        throw new Error(
          "V2 required-plugin namespace has duplicate/colliding native records; explicit remediation is required.",
        );
      const managed = path.join(root, "plugins", v2ManagedPluginFilename(artifact));
      const manual = [
        artifact.directory,
        fileURLToPath(artifact.entryUri),
        path.join(artifact.directory, "server.js"),
      ];
      const source = matches[0]?.source;
      const retainedManual = await atV2SetupStage("manual-bootstrap", () =>
        readV2CompatibleManualBootstrap(artifact, client, directory, signal, eligibility, root),
      );
      if (retainedManual) {
        authority.assertCurrent();
        await setupV2NativeFamily(
          retainedManual,
          client,
          directory,
          root,
          authority,
          configured,
          eligibility,
        );
        return retainedManual;
      }
      signal?.throwIfAborted();
      if (source && (source.type !== "local" || ![managed, ...manual].includes(source.path)))
        throw new Error(
          "V2 required-plugin namespace/source belongs to another native entry; foreign issuer/source was not replaced.",
        );
      const explicit = configured.some((entry) =>
        [artifact.pluginUri, artifact.entryUri, artifact.directory, ...manual].includes(entry),
      );
      if ((source?.type === "local" && manual.includes(source.path)) || explicit) {
        // Manual compatibility is a primary verified path, never a fallback after an installer failure.
        await settleV2PluginReadiness(
          artifact,
          client,
          directory,
          authority,
          manual,
          eligibility,
          root,
        );
        await setupV2NativeFamily(
          artifact,
          client,
          directory,
          root,
          authority,
          configured,
          eligibility,
        );
        return artifact;
      }
      v2NativeRuntimePlatform();
      await atV2SetupStage("eligibility", () =>
        eligibility(artifact, client, directory, root, authority.signal),
      );
      authority.assertCurrent();
      await atV2SetupStage("publication", () => publishV2ManagedPlugin(artifact, root, authority));
      await setupV2NativeFamily(
        artifact,
        client,
        directory,
        root,
        authority,
        configured,
        eligibility,
      );
      signal?.throwIfAborted();
      await atV2SetupStage("readiness", () =>
        settleV2PluginReadiness(
          artifact,
          client,
          directory,
          authority,
          [managed],
          eligibility,
          root,
        ),
      );
      const final = await atV2SetupStage("final-source", () =>
        v2Request(
          "required plugin final source",
          (signal) => client.plugin.list({ location: { directory } }, { signal }),
          { signal: authority.signal },
        ),
      );
      authority.assertCurrent();
      const installed = final.data.filter(
        (plugin) => plugin.id === v2ThreadRegistration(artifact).id,
      );
      if (
        installed.length !== 1 ||
        installed[0]?.source.type !== "local" ||
        installed[0].source.path !== managed
      )
        throw new Error(
          "V2 managed required-plugin source/namespace did not verify; no native history acquisition.",
        );
      return artifact;
    })();
  };
}

/** Watching settles through bounded reads only; native reload/service administration is never attempted. */
async function settleV2PluginReadiness(
  artifact: V2PluginSetupArtifact,
  client: OpencodeV2Client,
  directory: string,
  authority: V2PluginSetupAuthority,
  expectedSources: string[],
  eligibility: V2NativeEligibilityVerifier,
  root: string,
) {
  for (let attempt = 0; attempt < 6; attempt++) {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    authority.waiterSignal?.throwIfAborted();
    const inventory = await v2Request(
      "required plugin settled namespace",
      (signal) => client.plugin.list({ location: { directory } }, { signal }),
      { signal: authority.signal },
    );
    authority.assertCurrent();
    const records = inventory.data.filter(
      (plugin) => plugin.id === v2ThreadRegistration(artifact).id,
    );
    if (inventory.data.length > 1000 || records.length > 1)
      throw new Error(
        "V2 required-plugin settled namespace has duplicate/colliding records; explicit remediation is required.",
      );
    if (
      records.length === 1 &&
      records[0]?.state.status === "active" &&
      records[0].source.type === "local" &&
      expectedSources.includes(records[0].source.path)
    ) {
      try {
        await verifyV2ThreadTools(
          artifact,
          client,
          directory,
          authority.signal,
          undefined,
          eligibility,
          root,
        );
        authority.assertCurrent();
        return;
      } catch (error) {
        if (error instanceof V2NativeCompatibilityError) throw error;
        authority.assertCurrent();
        authority.signal.throwIfAborted();
      }
    }
    if (attempt < 5) await delay(200, undefined, { signal: authority.signal });
  }
  throw new Error(
    "V2 required bigbud thread-tools setup is not verified for the detected chat Location. Native watching may still be settling or a configured entry may be incompatible; no create/update/prompt or fallback was admitted. Retry setup; bigbud does not invoke native reload.",
  );
}
