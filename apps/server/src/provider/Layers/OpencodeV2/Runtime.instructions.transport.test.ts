import { expect, it, vi } from "vitest";
import { MessageId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import {
  syncV2Instructions,
  v2InstructionEntries,
  type V2InstructionStage,
} from "./Runtime.instructions.ts";
import { v2ExecutionGuard } from "./Runtime.authorization.ts";
import { Effect } from "effect";
import { makeV2Client } from "./Client.ts";
import { runV2RequestContext } from "./Client.guard.ts";
import { dispatchV2Turn } from "./Runtime.admission.ts";
import type { InstructionEntryInfo } from "@opencode/client";

it("prepares borrowed-session instructions through the installed client without dispatching a prompt", async () => {
  await withV2RuntimeFixture(async ({ runtime, http, directory }) => {
    Object.assign(runtime.options, { enableLocalTools: true });
    const threadId = ThreadId.makeUnsafe("instruction-transport");
    await runtime.start({
      threadId,
      cwd: directory,
      runtimeMode: "full-access",
      modelSelection: {
        provider: "opencodeV2",
        subProviderID: "synthetic-provider",
        model: "synthetic-model",
      },
    });
    const owner = runtime.get(threadId);
    const transport = "/synthetic/service.json";
    const entries = new Map<string, InstructionEntryInfo["value"]>();
    const instructionCalls: string[] = [];
    const root = `/api/experimental/session/${owner.native.id}/instructions/entries`;
    const client = makeV2Client({
      endpoint: "http://127.0.0.1:45991",
      sharedTransport: transport,
      fetch: Object.assign(
        async (request: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const pathname = new URL(String(request)).pathname;
          if (pathname.endsWith("/prompt")) throw new Error("Prompt transport forbidden");
          if (!pathname.includes("/instructions/")) return http.fetch(String(request), init);
          const method = init?.method ?? "GET";
          instructionCalls.push(method);
          // Independent wire contract: live 2.1.3 GET returns {data:[]}; writes return empty 204.
          if (pathname === root && method === "GET")
            return Response.json({ data: [...entries].map(([key, value]) => ({ key, value })) });
          expect(pathname.startsWith(`${root}/`)).toBe(true);
          const key = decodeURIComponent(pathname.slice(root.length + 1));
          expect(key).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
          if (method === "PUT") {
            const body = JSON.parse(String(init?.body));
            expect(Object.keys(body)).toEqual(["value"]);
            entries.set(key, body.value);
          } else {
            expect(method).toBe("DELETE");
            entries.delete(key);
          }
          return new Response(null, { status: 204 });
        },
        { preconnect: () => {} },
      ) as typeof fetch,
    });
    Object.assign(owner.lease.process, { ownership: "borrowed", client });
    const stages: V2InstructionStage[] = [];
    const prompt = vi
      .spyOn(client.session, "prompt")
      .mockRejectedValue(new Error("Prompt forbidden in preparation test"));
    try {
      await runV2RequestContext(
        {
          transport,
          intent: "execute",
          permit: {
            revision: 1,
            signal: new AbortController().signal,
            assertCurrent: () => {},
            release: () => {},
          },
        },
        async () => {
          const guard = v2ExecutionGuard(runtime, owner);
          let authorizations = 0;
          await expect(
            dispatchV2Turn(
              runtime.options,
              owner,
              {
                threadId,
                requestMessageId: MessageId.makeUnsafe("preparation-only"),
                input: "not dispatched",
              },
              runtime.mutations,
              async () => {
                if (++authorizations > v2InstructionEntries(owner).length)
                  throw new Error("Deliberate stop after instruction preparation");
                return guard();
              },
              () => {},
            ),
          ).rejects.toMatchObject({
            detail:
              "V2 execution authorization failed. No prompt dispatched; retry the same request after resolving preparation.",
          });
          await Effect.runPromise(
            Effect.promise(() =>
              syncV2Instructions(owner, runtime.mutations, [], guard, (stage) =>
                stages.push(stage),
              ),
            ),
          );
          await syncV2Instructions(
            owner,
            runtime.mutations,
            v2InstructionEntries(owner),
            guard,
            (stage) => stages.push(stage),
          );
        },
      );
      expect(owner.row?.state).toBe("reserved");
      expect(stages).toContain("read-back verification");
      expect([...entries].map(([key, value]) => ({ key, value }))).toEqual(
        v2InstructionEntries(owner),
      );
      expect(instructionCalls).toContain("PUT");
      expect(instructionCalls).toContain("DELETE");
      expect(prompt).not.toHaveBeenCalled();
      expect(() => runtime.mutations.assertSafe()).not.toThrow();
    } finally {
      Object.assign(owner.lease.process, { client: http.client });
    }
  });
});
