import path from "node:path";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { randomBytes } from "node:crypto";
import { Schema } from "effect";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  V2PluginPublication,
  v2ManagedPluginFilename,
  v2PublicationProtocol,
  v2ManagedPluginEntry,
  v2PluginContentHash,
  type V2PluginSetupArtifact,
} from "./PluginSetup.record.ts";
import {
  v2NativePluginDirectory,
  ensureV2NativePluginsDirectory,
  readV2NativePluginFile,
  removeV2NativePluginStaging,
  type V2PluginFileIdentity,
} from "./PluginSetup.fs.ts";
import { acquireV2PluginPublicationLock } from "./PluginSetup.lock.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { assertV2PluginUpgradeIdle } from "./PluginSetup.upgrade.ts";
import { closeV2PublicationBoundary } from "./PluginSetup.publication.boundary.ts";
import { currentV2RequestContext, runV2RequestContext } from "./Client.guard.ts";
import { recoverV2InstallationRevalidation } from "./PluginSetup.revalidation.ts";
import { revalidateV2UnchangedPublication } from "./PluginSetup.revalidation.publication.ts";
import {
  stageV2NativePlugin,
  commitV2NativePlugin,
  finishV2NativePluginDirectory,
  type V2PluginStaging,
} from "./PluginSetup.staging.ts";

interface PublicationJob {
  digest: string;
  authority: V2PluginSetupAuthority;
  promise: Promise<void>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}
const jobs = new Map<string, PublicationJob>();

const v2NoAbort = (): void => {};

/** Compatible global publishers join one owned transaction; subscribers cannot cancel another's authority. */
export async function publishV2ManagedPlugin(
  artifact: V2PluginSetupArtifact,
  root: string,
  authority: V2PluginSetupAuthority,
) {
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  authority.waiterSignal?.throwIfAborted();
  const key = JSON.stringify([root, artifact.issuer, v2ManagedPluginFilename(artifact)]);
  let job = jobs.get(key);
  if (
    job &&
    (job.digest !== artifact.artifactDigest ||
      job.authority.signal.aborted ||
      job.authority.scopeKey !== authority.scopeKey)
  )
    throw new Error(
      "V2 required-plugin publication proposal conflicts with an active or revoked owned proposal.",
    );
  if (!job) {
    if (jobs.size >= 32) throw new Error("V2 required-plugin publication capacity reached.");
    const controller = new AbortController();
    const shared = {
      ...authority,
      signal: AbortSignal.any([authority.signal, controller.signal]),
      assertCurrent: () => {
        authority.assertCurrent();
        controller.signal.throwIfAborted();
        authority.publication?.assertGate();
      },
    };
    const context = currentV2RequestContext();
    const publish = () => publishExclusive(artifact, root, shared);
    const owned: PublicationJob = {
      digest: artifact.artifactDigest,
      authority: shared,
      promise: context
        ? runV2RequestContext(
            {
              ...context,
              operationGuard: () => {
                context.operationGuard?.();
                shared.assertCurrent();
              },
              observeOperation: (operation) => {
                context.observeOperation?.(operation);
                authority.publication?.observePhysical?.(operation);
              },
            },
            publish,
          )
        : publish(),
      controller,
      waiters: 0,
      settled: false,
    };
    jobs.set(key, owned);
    job = owned;
    void owned.promise
      .finally(() => {
        owned.settled = true;
        if (jobs.get(key) === owned) jobs.delete(key);
      })
      .catch(() => {});
  }
  job.waiters++;
  const signal = authority.waiterSignal
    ? AbortSignal.any([authority.signal, authority.waiterSignal])
    : authority.signal;
  let abort: () => void = v2NoAbort;
  const detached = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new Error(
          "V2 required-plugin setup waiter cancelled/revoked; no successor publication authority.",
        ),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    await Promise.race([job.promise, detached]);
    authority.assertCurrent();
    signal.throwIfAborted();
  } catch (error) {
    if (authority.publication?.joinPhysicalOnCancel) await Promise.allSettled([job.promise]);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    job.waiters--;
    if (!job.waiters && !job.settled) job.controller.abort();
  }
}

async function publishExclusive(
  artifact: V2PluginSetupArtifact,
  root: string,
  authority: V2PluginSetupAuthority,
) {
  await artifact.verify();
  const rootIdentity = await v2NativePluginDirectory(root);
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  const records = await V2ThreadRecords.open(
    artifact.root,
    "installations",
    artifact.privateKey,
    artifact.publicKey,
  );
  const key = JSON.stringify([root, v2ManagedPluginFilename(artifact)]);
  let saved = await records.read(key);
  let record = saved
    ? Schema.decodeUnknownSync(V2PluginPublication)(saved.value, { onExcessProperty: "error" })
    : undefined;
  const wanted = v2ManagedPluginEntry(artifact, root);
  if (
    await revalidateV2UnchangedPublication(
      artifact,
      root,
      rootIdentity,
      authority,
      records,
      key,
      saved,
    )
  )
    return;
  const identityChanged = record && record.rootIdentity.dev !== rootIdentity.dev;
  if (record?.phase !== "committed" || record.next.hash !== wanted.hash || identityChanged)
    await authority.publication?.prepare();
  const reboot =
    record &&
    saved &&
    authority.publication &&
    typeof record.rootIdentity.dev === "number" &&
    typeof rootIdentity.dev === "number" &&
    record.rootIdentity.dev !== rootIdentity.dev
      ? await recoverV2InstallationRevalidation(records, key, saved, artifact, root)
      : undefined;
  if (reboot) record = reboot.record;
  if (
    record &&
    (record.root !== root ||
      record.next.issuer !== artifact.issuer ||
      record.rootIdentity.dev !== rootIdentity.dev ||
      record.rootIdentity.ino !== rootIdentity.ino)
  )
    throw new Error(
      "V2 required-plugin publication belongs to a changed native config root/principal; evidence retained.",
    );
  if (record) await v2NativePluginDirectory(path.join(root, "plugins"), record.pluginsIdentity);
  const needsPublication =
    !!reboot || record?.phase !== "committed" || record.next.hash !== wanted.hash;
  const releaseBoundary = needsPublication
    ? await closeV2PublicationBoundary(artifact, root, authority)
    : async () => {};
  try {
    if (reboot) {
      const revision = await reboot.archive(authority);
      saved = await records.read(key);
      if (saved?.revision !== revision)
        throw new Error("V2 installation revalidation successor preserved after adoption.");
    }
    const plugins = await ensureV2NativePluginsDirectory(root, rootIdentity, authority);
    const filename = path.join(plugins.directory, v2ManagedPluginFilename(artifact));
    const read = () => readV2NativePluginFile(filename, true, 16384);
    let existing = await read();
    if (
      record &&
      (record.pluginsIdentity.dev !== plugins.identity.dev ||
        record.pluginsIdentity.ino !== plugins.identity.ino)
    )
      throw new Error("V2 required-plugin directory identity changed; no automatic repair.");
    const belongs = (
      content: string,
      identity: V2PluginFileIdentity,
      hash: string | undefined,
      owned: V2PluginFileIdentity | null | undefined,
    ) =>
      v2PluginContentHash(content) === hash &&
      owned?.dev === identity.dev &&
      owned.ino === identity.ino;
    if (
      existing &&
      (!record ||
        (!belongs(existing.content, existing.identity, record.next.hash, record.nextIdentity) &&
          !belongs(
            existing.content,
            existing.identity,
            record.previous?.hash,
            record.previousIdentity,
          )))
    )
      throw new Error(
        `V2 required-plugin filename is not this app's exact signed prior entry (${record ? "content or file identity changed" : "installation record missing for this profile"}); collision preserved. Native configuration was not overwritten.`,
      );
    if (record && !existing && record.phase !== "reserved")
      throw new Error(
        "V2 required plugin was removed or publication is uncertain; automatic setup will not override native removal.",
      );
    if (existing?.content === wanted.content && record?.next.hash === wanted.hash) {
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      if (record.phase !== "committed")
        await records.replace(key, saved!.revision, { ...record, phase: "committed" });
      return;
    }
    if (existing && existing.content !== wanted.content && !authority.publication) {
      await assertV2PluginUpgradeIdle(artifact);
      authority.assertCurrent();
      authority.signal.throwIfAborted();
    }
    const unlock = await acquireV2PluginPublicationLock(
      plugins.directory,
      plugins.identity,
      root,
      artifact,
      authority,
      v2ThreadRegistration(artifact).family,
    );
    let staging: V2PluginStaging | undefined;
    let retainWindowsStaging = false;
    try {
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      const observed = await records.read(key);
      if (observed?.revision !== saved?.revision)
        throw new Error(
          "V2 required-plugin publication successor preserved; retry current evidence.",
        );
      existing = await read();
      const previous =
        existing && record
          ? v2PluginContentHash(existing.content) === record.next.hash
            ? record.next
            : record.previous
          : null;
      if (existing && !previous)
        throw new Error("V2 required-plugin upgrade lacks exact predecessor authority.");
      record = {
        protocol: v2PublicationProtocol(artifact),
        root,
        rootIdentity,
        pluginsIdentity: plugins.identity,
        phase: "reserved",
        previous: previous ?? null,
        next: wanted,
        previousIdentity: existing?.identity ?? null,
        nextIdentity: null,
      };
      let revision = await records.replace(key, saved?.revision, record);
      await v2NativePluginDirectory(root, rootIdentity);
      await v2NativePluginDirectory(plugins.directory, plugins.identity);
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      const temporary = path.join(
        plugins.directory,
        `.bigbud-thread-tools.${randomBytes(16).toString("hex")}.pending`,
      );
      await stageV2NativePlugin(temporary, wanted.content, plugins, authority, (created) => {
        staging = created;
      });
      const staged = await readV2NativePluginFile(temporary, true, 16384);
      if (staged?.content !== wanted.content)
        throw new Error("V2 required-plugin staging verification failed.");
      record = {
        ...record,
        phase: "publishing",
        nextIdentity: staged!.identity,
      };
      if (existing) await assertV2PluginUpgradeIdle(artifact);
      await authority.publication?.beforeMutation();
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      authority.publication?.assertGate();
      revision = await records.replace(key, revision, record);
      await v2NativePluginDirectory(root, rootIdentity);
      await v2NativePluginDirectory(plugins.directory, plugins.identity);
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      const prior = await read();
      if (
        prior?.content !== existing?.content ||
        prior?.identity.dev !== existing?.identity.dev ||
        prior?.identity.ino !== existing?.identity.ino
      )
        throw new Error("V2 required-plugin native filename changed; successor preserved.");
      const finalStaged = await readV2NativePluginFile(temporary, true, 16384);
      if (
        finalStaged?.content !== wanted.content ||
        finalStaged.identity.dev !== staging!.dev ||
        finalStaged.identity.ino !== staging!.ino
      )
        throw new Error("V2 required-plugin staging identity changed; no publication.");
      retainWindowsStaging = process.platform === "win32";
      await commitV2NativePlugin(
        temporary,
        filename,
        finalStaged,
        prior,
        plugins.identity,
        authority,
      );
      retainWindowsStaging = false;
      authority.publication?.assertGate();
      if (!existing)
        await removeV2NativePluginStaging(temporary, staging!, () => {
          authority.assertCurrent();
          authority.signal.throwIfAborted();
          authority.publication?.assertGate();
        });
      staging = undefined;
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      const committed = await read();
      if (committed?.content !== wanted.content)
        throw new Error(
          "V2 required-plugin publication acknowledgment uncertain; evidence retained.",
        );
      await finishV2NativePluginDirectory(plugins.directory, plugins.identity);
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      await records.replace(key, revision, { ...record, phase: "committed" });
    } finally {
      try {
        let cleanupAllowed = !retainWindowsStaging;
        try {
          authority.publication?.assertGate();
        } catch {
          cleanupAllowed = false;
        }
        if (staging && cleanupAllowed)
          await removeV2NativePluginStaging(staging.path, staging, () => {
            authority.assertCurrent();
            authority.signal.throwIfAborted();
            authority.publication?.assertGate();
          });
      } finally {
        await unlock();
      }
    }
  } finally {
    await releaseBoundary();
  }
}
