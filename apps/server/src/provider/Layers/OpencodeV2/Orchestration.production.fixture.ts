import { Effect } from "effect";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { realpath, mkdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SERVER_SETTINGS, MessageId, ThreadId } from "@bigbud/contracts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import type { FixtureTool } from "./Orchestration.plugin.host.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ApplicationOrchestration } from "./Application.orchestration.ts";
import { verifyV2ThreadTools } from "./Orchestration.readiness.ts";
import { makeV2SharedTargetPreparation } from "./Application.targets.shared.ts";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { sharedV2FixtureOptions } from "./SharedService.binding.fixture.ts";
import { V2ConsentAuthority } from "./Application.consent.ts";
import { makeTestSettings } from "../../../ws/serverSettings.testing.ts";
import { OpencodeV2Runtime } from "./Runtime.ts";
import { makeV2NativeDelegationFixture } from "./Execution.delegation.fixture.ts";
import { makeV2SyntheticNativeEligibility } from "./NativeCompatibility.runtime.fixture.ts";
import type { V2ImplementationVersion } from "./Orchestration.implementation.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import { verifyV2NativeEligibility } from "./NativeCompatibility.runtime.ts";
import { makeV2RuntimeCheckedTransport } from "./NativeCompatibility.runtime.transport.fixture.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";

export type V2ProductionInvoke = (
  action: string,
  input: Record<string, unknown>,
  callID?: string,
) => Promise<unknown>;

/** Real production listener/enrollment/approval/receipts + canonical HTTP/SQLite; only native projection is synthetic. */
export async function withV2ProductionThreadTools(
  run: (fixture: {
    runtime: OpencodeV2Runtime;
    source: V2RuntimeSession;
    canonical: Awaited<Effect.Success<ReturnType<typeof makeV2NativeDelegationFixture>>>;
    invoke: V2ProductionInvoke;
    invokeFor: (session: V2RuntimeSession) => V2ProductionInvoke;
    selectImplementation: (version: V2ImplementationVersion) => Promise<void>;
    artifact: V2PluginSetupArtifact;
    events: Parameters<Parameters<typeof withV2RuntimeFixture>[0]>[0]["events"];
    http: Parameters<Parameters<typeof withV2RuntimeFixture>[0]>[0]["http"];
    revokeConsent: () => Promise<void>;
    runtimeProof: () => Promise<V2NativeRuntimeProof>;
  }) => Promise<void>,
  mode: "full-access" | "approval-required" = "full-access",
  runtimeCheckedVersion?: string,
) {
  await withV2RuntimeFixture(async ({ runtime: baseline, http, directory, events }) => {
    const app = await makeV2ThreadPluginFixture();
    const configRoot = path.join(app.root, "owned-native-global");
    await mkdir(configRoot, { mode: 0o700 });
    http.client.config.get = async () => [{ type: "directory", path: configRoot }];
    const transport = runtimeCheckedVersion
      ? await makeV2RuntimeCheckedTransport(http.client, runtimeCheckedVersion)
      : undefined;
    const eligibility = transport
      ? verifyV2NativeEligibility
      : makeV2SyntheticNativeEligibility(http.client, app.artifact, configRoot);
    const infrastructure = await makeV2ApplicationOrchestration(
      app.root,
      (artifact, client, cwd, signal) =>
        verifyV2ThreadTools(artifact, client, cwd, signal, undefined, eligibility, configRoot),
      eligibility,
      configRoot,
    );
    const host = makeV2ThreadPluginHost(app.bind("unrelated-bootstrap", await realpath(directory)));
    if (runtimeCheckedVersion) host.context.app.version = runtimeCheckedVersion;
    host.context.session.get = async ({ sessionID }) => {
      const native = http.sessions.get(sessionID);
      if (!native) throw new Error("native fixture history missing");
      return {
        ...native,
        metadata: native.metadata as {
          bigbud_provider: string;
          bigbud_thread: string;
          bigbud_storage: string;
        },
      };
    };
    http.client.rpc.call = async (input) => ({
      output: await host.call(input.method, input.input),
    });
    http.client.plugin.list = async () => ({
      location: { directory: await realpath(directory) },
      data: [
        {
          id: v2ThreadRegistration(app.artifact).id,
          source: { type: "local", path: app.artifact.directory },
          features: { server: true, rpc: true },
          state: { status: "active" },
        },
      ],
    });
    const plugin = (await import(app.artifact.entryUri)).default;
    const dispose = await plugin.setup(host.context);
    const settings = await Effect.runPromise(
      makeTestSettings({
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          opencodeV2: {
            enabled: true,
            binaryPath: "",
            profileRoot: "",
            connectionMode: "shared",
            nativeServiceTrust: "managed-thread-tools-v2",
          },
        },
      }),
    );
    const consent = new V2ConsentAuthority(settings);
    const options = {
      ...sharedV2FixtureOptions(baseline, http, consent),
      enableLocalTools: true,
      threadBridge: infrastructure.bridge,
      threadToolsPreflight: infrastructure.preflight,
      profileIssuer: async () => app.artifact.issuer,
      ...(transport
        ? { config: { runtimeTargetId: "local", sharedService: transport.descriptor } }
        : {}),
    };
    http.autoComplete = false;
    http.models.push({ ...http.models[0]!, providerID: "bigbud-v2-fixture" });
    const threadId = ThreadId.makeUnsafe("production-source");
    let runtime: OpencodeV2Runtime | undefined;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const canonical = yield* makeV2NativeDelegationFixture({
              profile: app.root,
              workspace: directory,
              parent: threadId,
              runtimeMode: mode,
              consumeChildren: false,
            });
            runtime = new OpencodeV2Runtime({
              ...options,
              prepareSession: makeV2SharedTargetPreparation(options, app.root, canonical.port),
            });
            yield* Effect.promise(() =>
              runtime!.start({
                threadId,
                cwd: directory,
                modelSelection: canonical.selection,
                runtimeMode: mode,
              }),
            );
            yield* Effect.promise(() =>
              runtime!.send({
                threadId,
                input: "Use canonical thread tools",
                requestMessageId: MessageId.makeUnsafe("production-input"),
              }),
            );
            const source = runtime.get(threadId);
            let counter = 0;
            const invokeFor =
              (session: V2RuntimeSession): V2ProductionInvoke =>
              async (
                action: string,
                input: Record<string, unknown>,
                callID = `call-${++counter}`,
              ) => {
                const messageID = `assistant-${callID}`;
                const messages = http.messages.get(session.native.id)!;
                if (!messages.some((message) => message.id === messageID))
                  messages.push({
                    id: messageID,
                    type: "assistant",
                    agent: "build",
                    model: session.model,
                    time: { created: 3 },
                    content: [
                      {
                        type: "tool",
                        id: callID,
                        name: v2ThreadRegistration(app.artifact).tool(action as "create_thread"),
                        time: { created: 3 },
                        state: { status: "running", input: input as never, metadata: {} },
                      },
                    ],
                  });
                const tool: FixtureTool | undefined = host.tools.get(
                  v2ThreadRegistration(app.artifact).tool(action as "create_thread"),
                );
                if (!tool) throw new Error("fixture required tool absent");
                const output = await tool.execute(input, {
                  sessionID: session.native.id,
                  messageID,
                  id: callID,
                  agent: "build",
                  signal: new AbortController().signal,
                });
                return JSON.parse(output.content);
              };
            yield* Effect.promise(() =>
              run({
                runtime: runtime!,
                source,
                canonical,
                invoke: invokeFor(source),
                invokeFor,
                artifact: infrastructure.artifact,
                selectImplementation: async (version) => {
                  const permit = consent.capture();
                  try {
                    await infrastructure.implementationSelection.select(version, permit);
                  } finally {
                    permit.release();
                  }
                },
                events,
                http,
                revokeConsent: () =>
                  Effect.runPromise(
                    settings.updateSettings({
                      providers: { opencodeV2: { nativeServiceTrust: null } },
                    }),
                  ).then(() => {}),
                runtimeProof: () =>
                  runtime!.authorized(() =>
                    eligibility(app.artifact, http.client, directory, configRoot),
                  ),
              }),
            );
          }),
        ),
      );
    } finally {
      await runtime?.close();
      consent.close();
      await dispose();
      await infrastructure.close();
      await app.close();
      await transport?.close();
    }
  });
}
