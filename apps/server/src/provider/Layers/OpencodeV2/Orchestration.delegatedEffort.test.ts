import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ModelSelection,
  type ThreadId,
  type ServerProviderModel,
} from "@bigbud/contracts";
import { Effect, Schema } from "effect";
import { expect, it, vi } from "vitest";
import {
  asThreadId,
  createSendTurnHarness,
} from "../../../codex/codexAppServerManager.test.helpers.ts";
import { createCodexThreadOrchestrationDynamicToolHandler } from "../../../orchestration-tools/codexThreadDynamicTools.ts";
import { toCodexManagerModelSelection } from "../Codex/Adapter.session.modelSelection.ts";
import {
  getThreadToolModelSources,
  setThreadToolModelSources,
} from "../../../orchestration-tools/ThreadOrchestrationToolDispatcher.ts";
import { provider } from "../../../orchestration-tools/ThreadOrchestrationTools.modelChoice.test.helpers.ts";
import { normalizeV2Catalog } from "./Catalog.ts";
import { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { withV2ProductionThreadTools } from "./Orchestration.production.fixture.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";

const codexModel = {
  slug: "gpt-5.4",
  name: "GPT-5.4",
  isCustom: false,
  capabilities: {
    reasoningEffortLevels: [{ value: "xhigh", label: "Extra High" }],
    effortMetadataOrigin: "live",
    effortMetadataStatus: "verified-supported",
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  },
} satisfies ServerProviderModel;

function installCatalog(models: ReadonlyArray<ServerProviderModel>) {
  const prior = getThreadToolModelSources();
  setThreadToolModelSources({
    getProviders: Effect.succeed([
      provider("opencodeV2", {}, models),
      provider("codex", {}, [codexModel]),
    ]),
    getSettings: Effect.succeed({
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencodeV2: {
          ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2,
          nativeServiceTrust: "managed-thread-tools-v2",
        },
      },
    }),
    listRecent: () => Effect.succeed([]),
    hasInteractiveClient: () => false,
  });
  return () => setThreadToolModelSources(prior);
}

it("forwards ABI 6 model and effort over native tools and HTTP through queued reactor recovery", async () => {
  await withV2ProductionThreadTools(
    async ({ source, canonical, invoke, http }) => {
      const directory = source.native.location.directory;
      const models = normalizeV2Catalog({ location: { directory }, data: http.models }, directory);
      const restoreSources = installCatalog(models);
      const dispatch = canonical.engine.dispatch;
      const gate = (
        threadId: ThreadId,
        kind: "approval.requested" | "approval.resolved",
        createdAt: string,
      ) =>
        dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`fixture:${kind}`),
          threadId,
          createdAt,
          activity: {
            id: EventId.makeUnsafe(`fixture:${kind}`),
            kind,
            tone: "info",
            summary: kind,
            turnId: null,
            payload: { requestId: "synthetic-approval" },
            createdAt,
          },
        });
      // Introduce a genuine queue blocker between the canonical child creation and its first prompt.
      const spy = vi
        .spyOn(canonical.engine, "dispatch")
        .mockImplementation((command) =>
          command.type === "thread.create"
            ? dispatch(command).pipe(
                Effect.tap(() => gate(command.threadId, "approval.requested", command.createdAt)),
              )
            : dispatch(command),
        );
      try {
        expect(await invoke("list_available_models", { limit: 20 })).toMatchObject({
          ok: true,
          result: {
            models: expect.arrayContaining([
              expect.objectContaining({
                provider: "opencodeV2",
                model: canonical.selection.model,
                subProviderID: canonical.selection.subProviderID,
                effort: {
                  status: "supported",
                  levels: expect.arrayContaining([{ value: "precise", label: "precise" }]),
                },
              }),
            ]),
          },
        });
        const input = {
          title: "Precise child",
          task: "Synthetic first prompt",
          modelSelection: {
            ...canonical.selection,
            effort: "precise",
            options: { variant: "low" },
          },
        };
        const result = (await invoke("create_thread", input, "stable-effort")) as {
          result: { childThreadId: string };
        };
        const effort = { requested: "precise", configured: "precise", reason: null };
        const selection = { ...canonical.selection, options: { variant: "precise" } };
        expect(result).toMatchObject({ result: { modelChoice: { effort, used: selection } } });
        expect(await invoke("create_thread", input, "stable-effort")).toEqual(result);
        expect(canonical.dispatched).toHaveLength(1);
        expect(canonical.dispatched[0]?.modelSelection).toEqual({
          ...canonical.selection,
          effort: "precise",
        });
        const read = await canonical.run(canonical.engine.getReadModel());
        const child = read.threads.find((thread) => thread.id === result.result.childThreadId)!;
        expect(child.modelSelection).toEqual(selection);
        expect(await invoke("get_thread_status", { threadId: child.id })).toMatchObject({
          ok: true,
          status: { modelChoice: { effort } },
        });
        expect(child.queuedPrompts).toEqual([
          expect.objectContaining({
            text: expect.stringContaining(input.task),
            modelSelection: selection,
          }),
        ]);
        expect(child.session).toBeNull();
        const start = http.calls.length;
        await canonical.run(gate(child.id, "approval.resolved", new Date().toISOString()));
        await canonical.runQueuedTurns();
        const firstCalls = http.calls.slice(start);
        const created = firstCalls.findIndex(
          (call) => call.method === "POST" && call.pathname === "/api/session",
        );
        const prompted = firstCalls.findIndex(
          (call) => call.method === "POST" && call.pathname.endsWith("/prompt"),
        );
        expect(created).toBeGreaterThanOrEqual(0);
        expect(prompted).toBeGreaterThan(created);
        expect(firstCalls[created]?.body).toMatchObject({
          model: { id: selection.model, providerID: selection.subProviderID, variant: "precise" },
        });
        expect(JSON.stringify(firstCalls[prompted]?.body)).toContain(input.task);
      } finally {
        spy.mockRestore();
        restoreSources();
      }
    },
    "full-access",
    undefined,
    false,
    undefined,
    true,
  );
});

it("keeps a retained ABI 5 caller usable without silently advertising effort", async () => {
  await withV2ProductionThreadTools(
    async ({ artifact, invoke }) => {
      const registration = v2ThreadRegistration(artifact);
      expect(registration.tools).not.toContain(registration.tool("list_available_models"));
      await expect(
        invoke("create_thread", { title: "Legacy", task: "Continue" }),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        invoke("create_thread", {
          title: "Legacy",
          task: "New field",
          modelSelection: { provider: "codex", effort: "high" },
        }),
      ).rejects.toThrow();
    },
    "full-access",
    undefined,
    false,
    (stateDir) => exportV2ThreadArtifact(stateDir, "v5"),
  );
});

it("delegates effort in both directions between the OpenCode and Codex caller bindings", async () => {
  await withV2ProductionThreadTools(async ({ source, canonical, invoke, http, runtime }) => {
    const directory = source.native.location.directory;
    const restoreSources = installCatalog(
      normalizeV2Catalog({ location: { directory }, data: http.models }, directory),
    );
    try {
      const toCodex = (await invoke("create_thread", {
        title: "Codex worker",
        task: "Synthetic Codex first turn",
        modelSelection: { provider: "codex", model: codexModel.slug, effort: "xhigh" },
      })) as { result: { childThreadId: string } };
      const read = async (id: string) =>
        (await canonical.run(canonical.engine.getReadModel())).threads.find(
          (thread) => thread.id === id,
        )!;
      const codex = await read(toCodex.result.childThreadId);
      const codexSelection = Schema.decodeUnknownSync(ModelSelection)(codex.modelSelection);
      const manager = createSendTurnHarness({ activeModelCatalog: [codexModel] });
      await manager.manager.sendTurn({
        threadId: asThreadId("thread_1"),
        input: codex.messages.find((message) => message.role === "user")!.text,
        ...toCodexManagerModelSelection(codexSelection),
      });
      expect(manager.sendRequest).toHaveBeenCalledWith(
        manager.context,
        "turn/start",
        expect.objectContaining({ model: codexModel.slug, effort: "xhigh" }),
        undefined,
      );
      const codexTool = createCodexThreadOrchestrationDynamicToolHandler(codex.id);
      const toOpencode = await codexTool({
        namespace: "bigbud_orchestration",
        tool: "create_thread",
        requestId: 1,
        arguments: {
          title: "OpenCode worker",
          task: "Synthetic OpenCode first turn",
          modelSelection: { ...canonical.selection, effort: "low" },
        },
      });
      expect(toOpencode.success).toBe(true);
      const text = toOpencode.contentItems[0];
      if (text?.type !== "inputText") throw new Error("Expected dynamic-tool text output");
      const parsed = JSON.parse(text.text) as { childThreadId: string };
      const opencode = await read(parsed.childThreadId);
      const selection = Schema.decodeUnknownSync(ModelSelection)(opencode.modelSelection);
      const firstMessage = opencode.messages.find((message) => message.role === "user")!;
      await runtime.start({
        threadId: opencode.id,
        cwd: directory,
        modelSelection: selection,
        runtimeMode: "full-access",
      });
      await runtime.send({
        threadId: opencode.id,
        modelSelection: selection,
        input: firstMessage.text,
        requestMessageId: firstMessage.id,
      });
      expect(
        http.calls.findLast((call) => call.method === "POST" && call.pathname === "/api/session")
          ?.body,
      ).toMatchObject({
        model: {
          id: canonical.selection.model,
          providerID: canonical.selection.subProviderID,
          variant: "low",
        },
      });
    } finally {
      restoreSources();
    }
  });
});
