import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ThreadId, MessageId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { exportV2NativeFamilyArtifact } from "./Subagents.artifact.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { makeV2NativeFamilyPreparation } from "./Subagents.application.ts";
import { V2ActivationGate } from "./PluginSetup.activation.gate.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";
import type { NativeFamilyQualification } from "./Subagents.qualification.ts";
import type { ProviderSession } from "@bigbud/contracts";
import {
  makeV2NativeFamilySourceFixture,
  type V2NativeFamilySourceFixture,
} from "./Subagents.extension.fixture.ts";

type Hook = (event: Record<string, unknown>) => Promise<void>;
type NativeContext = {
  sessionID: string;
  messageID: string;
  id: string;
  signal: AbortSignal;
  progress: (metadata: Record<string, unknown>) => Promise<void>;
};
type NativeInput = {
  agent: string;
  description: string;
  prompt: string;
  sessionID?: string;
  background?: boolean;
};
type Executor = (input: NativeInput, context: NativeContext) => Promise<unknown>;
type Fixture = Parameters<Parameters<typeof withV2RuntimeFixture>[0]>[0];
const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

/** Real emitted native plugin + production broker/factory, pinned HTTP client and SQLite.
 * Only the native engine and qualification evidence are deterministic fixtures; no native
 * executable, runner approval, release registry, configuration or paid model is touched.
 */
export async function withV2NativeGuardProduction(
  run: (
    fixture: Fixture & {
      owner: ReturnType<Fixture["runtime"]["get"]>;
      launch: (background?: boolean, continuation?: string, parentID?: string) => Promise<string>;
      nativeFamily?: V2NativeFamilySourceFixture;
      context: (sessionId: string) => Promise<void>;
      permission: (sessionId: string, action: string, resources: string[]) => Promise<string>;
      send: (id: string) => Promise<void>;
      dispose: () => Promise<void>;
      artifact: Awaited<ReturnType<typeof exportV2NativeFamilyArtifact>>;
      storage: Map<string, unknown>;
    },
  ) => Promise<void>,
  runtimeMode: ProviderSession["runtimeMode"] = "full-access",
  nativeResult: "completed" | "running" = "completed",
  extension = false,
  reportedFamily?: { abi?: string; sourceDigest?: string },
) {
  await withV2RuntimeFixture(async (fixture) => {
    const { runtime, http } = fixture;
    const directory = await realpath(fixture.directory);
    const stateDir = await realpath(runtime.options.config.profileRoot);
    Object.assign(runtime.options.config, { profileRoot: stateDir });
    const artifact = await exportV2NativeFamilyArtifact(stateDir);
    const canonical = await exportV2ThreadArtifact(stateDir);
    const nativeFamily = extension
      ? await makeV2NativeFamilySourceFixture(http, artifact.rpcID)
      : undefined;
    const storage = new Map<string, unknown>(),
      hooks = new Map<string, Hook[]>();
    const rpc = new Map<string, (input: unknown) => Promise<unknown>>();
    const nativeFetch = http.fetch.bind(http);
    let sequence = 0;
    const tool: { execute: Executor } = {
      execute: async (input, context) => {
        const ticket = await nativeFamily?.begin(
          context.sessionID,
          context.messageID,
          context.id,
          input.sessionID,
        );
        const parent = http.sessions.get(context.sessionID)!;
        const childId = input.sessionID ?? `ses_native_fixture_${++sequence}`;
        if (!http.sessions.has(childId)) {
          http.sessions.set(childId, {
            ...parent,
            id: childId,
            parentID: parent.id,
            agent: input.agent,
            title: input.description,
            time: { created: 10, updated: 11 },
          });
          http.messages.set(childId, []);
        }
        await nativeFamily?.created(ticket, childId);
        await context.progress({ sessionID: childId, status: "running" });
        await http.client.session.prompt({
          sessionID: childId,
          id: `msg_child_${++sequence}`,
          text: input.prompt,
          resume: true,
        });
        await nativeFamily?.started(
          ticket,
          childId,
          input.background === true || nativeResult === "running",
        );
        return {
          output: { sessionID: childId, status: nativeResult, output: "offline native result" },
          metadata: { sessionID: childId, status: nativeResult },
          content: "offline native result",
        };
      },
    };
    const registerHook = async (name: string, hook: Hook) => {
      const current = hooks.get(name) ?? [];
      current.push(hook);
      hooks.set(name, current);
      return {
        dispose: async () => {
          hooks.set(
            name,
            (hooks.get(name) ?? []).filter((entry) => entry !== hook),
          );
        },
      };
    };
    const ctx = {
      app: { version: "2.0.26" },
      location: { directory },
      session: {
        ...http.client.session,
        hook: registerHook,
        ...(nativeFamily ? { family: { ...nativeFamily.domain, ...reportedFamily } } : {}),
      },
      permission: { hook: registerHook },
      storage: {
        get: async (key: string) => storage.get(key),
        set: async (key: string, value: unknown) => {
          storage.set(key, structuredClone(value));
        },
      },
      tool: {
        transform: async (edit: (editor: unknown) => void) => {
          edit({
            get: () => tool,
            update: (_id: string, update: (tool: { execute: Executor }) => void) => update(tool),
          });
          return { dispose: async () => {} };
        },
      },
      rpc: {
        register: async (
          _contract: unknown,
          methods: Record<string, (input: unknown) => Promise<unknown>>,
        ) => {
          for (const [name, method] of Object.entries(methods)) rpc.set(name, method);
          return {
            dispose: async () => {
              rpc.clear();
            },
          };
        },
      },
    };
    const native = (await import(pathToFileURL(`${artifact.directory}/index.mjs`).href)) as {
      default: { setup(ctx: unknown): Promise<() => Promise<void>> };
    };
    const dispose = await native.default.setup(ctx);
    const fetch: typeof http.fetch = async (url, init) => {
      const pathname = new URL(url).pathname,
        parts = pathname.split("/");
      if (pathname.startsWith("/api/rpc/"))
        return response({
          output: await rpc.get(parts.at(-1)!)!(JSON.parse(String(init?.body)).input),
        });
      if (pathname === "/api/plugin")
        return response({
          location: { directory },
          data: [
            {
              id: `bigbud.thread.v2.${artifact.issuer}`,
              source: { type: "local", path: canonical.directory },
              state: { status: "active" },
              features: {},
            },
            {
              id: artifact.rpcID,
              source: { type: "local", path: artifact.directory },
              state: { status: "active" },
              features: {},
            },
          ],
        });
      if (pathname.startsWith("/api/agent/")) {
        const id = parts.at(-1)!;
        return response({
          location: { directory },
          data: {
            id,
            name: id,
            request: {},
            mode: "all",
            hidden: false,
            permissions: [
              { action: "*", resource: "*", effect: "allow" },
              { action: "read", resource: "private", effect: "deny" },
              { action: "shell", resource: "ask-child", effect: "ask" },
            ],
          },
        });
      }
      if (pathname.endsWith("/context"))
        return response({ data: http.messages.get(parts[3]!) ?? [] });
      if (pathname.endsWith("/prompt")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const event = {
          sessionID: parts[3]!,
          messageID: body.id,
          metadata: body.metadata,
          delivery: body.delivery ?? "steer",
          prompt: { text: body.text },
        };
        for (const hook of hooks.get("prompt") ?? []) await hook(event);
        return nativeFetch(url, {
          ...init,
          body: JSON.stringify({ ...body, metadata: event.metadata }),
        });
      }
      if (
        pathname.endsWith("/interrupt") &&
        http.sessions.has(parts[3]!) &&
        http.sessions.get(parts[3]!)!.parentID
      ) {
        const current = http.sessions.get(parts[3]!)!;
        http.sessions.set(current.id, {
          ...current,
          outcome: "interrupted",
          time: { ...current.time, updated: Date.now(), idle: Date.now() + 1 },
        });
        http.inbox.set(current.id, []);
        http.permissions.set(current.id, []);
      }
      return nativeFetch(url, init);
    };
    http.fetch = fetch;
    const record: NativeFamilyQualification = {
      id: "offline-source-fixture-only",
      nativeQualificationRecordId: "offline-source-fixture-only",
      nativeVersion: "2.0.26",
      guardDigest: artifact.artifactDigest,
      immutableSourceDigest: "a".repeat(64),
      executorProgressBeforePrompt: true,
      finalPermissionClamp: true,
      authenticatedRootGeneration: true,
      nativePromptHookFencesAdmission: true,
      syntheticAdmission: nativeFamily ? "opencode.native-family.v1" : "unsupported",
      ...(nativeFamily ? { nativeFamilySourceDigest: nativeFamily.sourceDigest } : {}),
    };
    const factory = makeV2NativeFamilyPreparation(stateDir, [record]);
    Object.assign(runtime.options, {
      enableLocalTools: true,
      profileIssuer: async () => artifact.issuer,
      nativeSubagents: {
        stateDirectory: stateDir,
        prepare: async (owner: ReturnType<typeof runtime.get>) => {
          const proof: V2NativeRuntimeProof = {
            ...(nativeFamily ? { nativeFamilySourceDigest: nativeFamily.sourceDigest } : {}),
            evidenceKind: "qualified",
            assertCurrent: () => {
              if (!http.running) throw new Error("offline transport exited");
            },
            assertConfigRead: () => {},
            transport: owner.storageIdentity,
            generation: String(owner.lease.generation),
            nativeVersion: "2.0.26",
            platform: "darwin",
            arch: "arm64",
            nativeContractDigest: "a".repeat(64),
            semanticProfile: "v2-global-config-v1",
            qualificationRecordId: record.nativeQualificationRecordId,
            consumedApiDigest: "b".repeat(64),
            directory,
            root: stateDir,
            consentRevision: 0,
            compatibilityDigest: canonical.compatibilityDigest,
          };
          const gate = new V2ActivationGate(
            JSON.stringify([stateDir, artifact.issuer, proof.transport, proof.generation]),
            canonical.artifactDigest,
            () => {},
          );
          owner.activation = {
            gate,
            stamp: gate.verify(directory, canonical.artifactDigest, "a".repeat(32), proof),
            phase: "settled",
          };
          return factory.prepare(owner, runtime);
        },
      },
    });
    const threadId = ThreadId.makeUnsafe("native-guard-production-fixture");
    try {
      await runtime.start({ threadId, cwd: directory, runtimeMode, modelSelection });
      const owner = runtime.get(threadId);
      const send = async (id: string) => {
        await runtime.send({
          threadId,
          requestMessageId: MessageId.makeUnsafe(id),
          modelSelection,
          input: `offline input ${id}`,
        });
        await runtime.reconcile(owner);
      };
      const launch = async (
        background = false,
        continuation?: string,
        parentID = owner.native.id,
      ) => {
        const result = (await tool.execute(
          {
            agent: "explore",
            description: "Offline native child",
            prompt: "offline assignment",
            background,
            ...(continuation ? { sessionID: continuation } : {}),
          },
          {
            sessionID: parentID,
            messageID: `msg_tool_${sequence}`,
            id: `call_${sequence}`,
            signal: new AbortController().signal,
            progress: async () => {},
          },
        )) as { output: { sessionID: string } };
        return result.output.sessionID;
      };
      const context = async (sessionID: string) => {
        for (const hook of hooks.get("context") ?? []) await hook({ sessionID });
      };
      const permission = async (sessionID: string, action: string, resources: string[]) => {
        const event = {
          sessionID,
          action,
          resources,
          effect: "allow",
          agent: http.sessions.get(sessionID)!.agent ?? "build",
        };
        for (const hook of hooks.get("evaluate") ?? []) await hook(event);
        return event.effect;
      };
      await run({
        ...fixture,
        owner,
        launch,
        context,
        permission,
        send,
        dispose,
        artifact,
        storage,
        ...(nativeFamily ? { nativeFamily } : {}),
      });
    } finally {
      await runtime.stop(threadId).catch(() => {});
      await factory.close();
      await dispose();
      http.fetch = nativeFetch;
    }
  });
}
