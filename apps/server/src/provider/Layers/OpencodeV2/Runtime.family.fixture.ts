import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { realpath } from "node:fs/promises";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { guardedV2SubagentExecutor } from "./Subagents.guard.ts";
import type { V2ChildLaunch } from "./Runtime.family.ts";

const modelSelection = {
  provider: "opencodeV2",
  subProviderID: "synthetic-provider",
  model: "synthetic-model",
} as const;
type Fixture = Parameters<Parameters<typeof withV2RuntimeFixture>[0]>[0];

/** Offline pinned-client + SQLite harness. No native process, settings, paid model or qualification registry is touched. */
export async function withV2OwnedFamily(
  run: (
    fixture: Fixture & {
      owner: ReturnType<Fixture["runtime"]["get"]>;
      launch: (id: string, parentId?: string) => Promise<void>;
      finish: (id: string) => void;
    },
  ) => Promise<void>,
) {
  await withV2RuntimeFixture(async (fixture) => {
    const { runtime, http, directory } = fixture;
    Object.assign(runtime.options.config, {
      profileRoot: await realpath(runtime.options.config.profileRoot),
    });
    let beforePrompt!: (launch: V2ChildLaunch) => Promise<void>;
    let beforeSpawn!: (parentId: string, continuationId?: string) => Promise<void>;
    Object.assign(runtime.options, {
      enableLocalTools: true,
      nativeSubagents: {
        stateDirectory: runtime.options.config.profileRoot,
        qualification: {
          assertCurrent: () => {},
          attach: async (
            _: unknown,
            callback: typeof beforePrompt,
            preflight: typeof beforeSpawn,
          ) => {
            beforePrompt = callback;
            beforeSpawn = preflight;
            return () => {};
          },
        },
      },
    });
    const threadId = ThreadId.makeUnsafe("owned-family-fixture");
    await runtime.start({ threadId, cwd: directory, runtimeMode: "full-access", modelSelection });
    const owner = runtime.get(threadId);
    const launch = async (id: string, parentId = owner.native.id) => {
      await beforeSpawn(parentId, http.sessions.has(id) ? id : undefined);
      if (!http.sessions.has(id)) {
        http.sessions.set(id, {
          ...owner.native,
          id,
          parentID: parentId,
          agent: "explore",
          title: "Inspect child",
          time: { created: 1, updated: 2 },
          permissions: [...(owner.toolPolicy ?? [])],
        });
        http.messages.set(id, []);
      }
      const execute = guardedV2SubagentExecutor(
        async (input, context) => {
          await context.progress({ sessionID: id, status: "running" });
          await http.client.session.prompt({
            sessionID: id,
            id: `msg_${id}`,
            text: input.prompt,
            resume: false,
          });
        },
        { assertCurrent: () => owner.family!.assertSpawn(), beforePrompt },
      );
      await execute(
        {
          agent: "explore",
          description: "Inspect child",
          prompt: "offline assignment",
          background: true,
        },
        {
          sessionID: parentId,
          messageID: "msg_launch",
          id: `call_${id}`,
          signal: new AbortController().signal,
          progress: async () => {},
        },
      );
    };
    const finish = (id: string) => {
      const native = http.sessions.get(id)!;
      http.sessions.set(id, {
        ...native,
        outcome: "interrupted",
        time: { ...native.time, updated: 5, idle: 6 },
      });
      http.inbox.set(id, []);
      http.permissions.set(id, []);
    };
    try {
      await run({ ...fixture, owner, launch, finish });
    } finally {
      for (const child of owner.family?.children ?? []) finish(child.id);
    }
  });
}
