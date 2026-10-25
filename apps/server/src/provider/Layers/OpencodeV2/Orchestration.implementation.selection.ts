import * as Schema from "effect/Schema";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { ensureV2ThreadPrivateChild } from "./Orchestration.storage.ts";
import { v2NativePluginDirectory } from "./PluginSetup.fs.ts";
import { acquireV2PluginPublicationLock } from "./PluginSetup.lock.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { captureV2OperationAuthority } from "./Client.guard.ts";
import {
  v2ThreadImplementation,
  type V2ImplementationVersion,
  type V2ThreadImplementationRegistry,
} from "./Orchestration.implementation.ts";

const Selection = Schema.Struct({
  protocol: Schema.Literal("bigbud.thread.implementation.selection.v1"),
  version: Schema.Literals(["v1", "v2"]),
  implementationDigest: Schema.String,
  bootstrapAbi: Schema.String,
  schemaDigest: Schema.String,
  canonicalRequestAbi: Schema.String,
  resultEncoding: Schema.String,
});
const valueFor = (version: V2ImplementationVersion) => {
  const implementation = v2ThreadImplementation(version);
  return {
    protocol: "bigbud.thread.implementation.selection.v1" as const,
    version,
    implementationDigest: implementation.implementationDigest,
    bootstrapAbi: implementation.bootstrapAbi,
    schemaDigest: implementation.schemaDigest,
    canonicalRequestAbi: implementation.canonicalRequestAbi,
    resultEncoding: implementation.resultEncoding,
  };
};

/** App-private signed selection never edits watched native assets, imports or registration state. */
export class V2ImplementationSelection {
  private constructor(
    private readonly artifact: V2PluginSetupArtifact,
    private readonly records: V2ThreadRecords,
    private readonly registry: V2ThreadImplementationRegistry,
  ) {}
  static async open(artifact: V2PluginSetupArtifact, registry: V2ThreadImplementationRegistry) {
    const records = await V2ThreadRecords.open(
      artifact.root,
      "implementations",
      artifact.privateKey,
      artifact.publicKey,
    );
    const selection = new V2ImplementationSelection(artifact, records, registry);
    await selection.refresh();
    return selection;
  }
  async refresh() {
    const signed = await this.records.read("default");
    if (!signed) return this.registry.current();
    const selected = Schema.decodeUnknownSync(Selection)(signed.value, {
      onExcessProperty: "error",
    });
    if (JSON.stringify(selected) !== JSON.stringify(valueFor(selected.version)))
      throw new Error(
        "V2 stored implementation selection no longer matches the trusted bundled closure/ABI.",
      );
    this.registry.select(selected.version);
    return this.registry.current();
  }
  async select(version: V2ImplementationVersion, requested: V2PluginSetupAuthority) {
    const authority = captureV2OperationAuthority(requested);
    const next = valueFor(version);
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    const directory = await ensureV2ThreadPrivateChild(
      this.artifact.root,
      "implementation-locks",
      authority,
    );
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    const unlock = await acquireV2PluginPublicationLock(
      directory,
      await v2NativePluginDirectory(directory),
      this.artifact.root,
      this.artifact,
      authority,
    );
    try {
      const previous = await this.records.read("default");
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      if (previous && JSON.stringify(previous.value) === JSON.stringify(next)) {
        this.registry.select(version);
        return;
      }
      if (previous)
        Schema.decodeUnknownSync(Selection)(previous.value, { onExcessProperty: "error" });
      await this.records.replace("default", previous?.revision, next, authority);
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      this.registry.select(version);
    } finally {
      await unlock();
    }
  }
}
