import type { PermissionRuleset } from "@opencode/client";
import { guardedV2SubagentExecutor, clampV2ChildPermission } from "./Subagents.guard.ts";
import type { V2ChildLaunch } from "./Runtime.family.ts";

interface PermissionEvent {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: readonly string[];
  effect: "allow" | "ask" | "deny";
}
interface Registration {
  dispose(): Promise<void>;
}
type Executor = Parameters<typeof guardedV2SubagentExecutor>[0];
export interface V2NativeGuardContext {
  readonly tool: {
    transform: (
      edit: (editor: {
        update(id: string, edit: (tool: { execute: Executor }) => void): void;
      }) => void,
    ) => Promise<Registration>;
  };
  readonly permission: {
    hook(name: "evaluate", run: (event: PermissionEvent) => Promise<void>): Promise<Registration>;
  };
  readonly session: {
    hook(
      name: "context",
      run: (event: { readonly sessionID: string }) => Promise<void>,
    ): Promise<Registration>;
  };
}
export interface V2NativeGuardAuthority {
  /** Resolves native ancestry and current signed enrollment; app-marked but unenrolled sessions MUST throw, not return false. */
  readonly owns: (nativeSessionId: string) => Promise<boolean>;
  /** Must fail on expired owner/generation, Stop, unknown child or unqualified plugin ordering. */
  readonly assertCurrent: (nativeSessionId: string) => Promise<void>;
  readonly captureCurrent: (nativeSessionId: string) => () => void;
  readonly beforePrompt: (launch: V2ChildLaunch) => Promise<void>;
  readonly beforeSpawn: (parentSessionId: string, continuationId?: string) => Promise<void>;
  readonly policy: (event: PermissionEvent) => Promise<{
    readonly parent: PermissionRuleset;
    readonly agent: PermissionRuleset;
    readonly overlay: PermissionRuleset;
  }>;
}

/** Separately versioned native plugin boundary. Never changes the frozen bigbud.thread.v2 bootstrap.
 * A publication adapter must attest this registration remains final on the selected native stack.
 */
export async function installV2NativeSubagentGuard(
  ctx: V2NativeGuardContext,
  authority: V2NativeGuardAuthority,
) {
  const registrations: Registration[] = [];
  try {
    registrations.push(
      await ctx.tool.transform((editor) =>
        editor.update("subagent", (tool) => {
          const original = tool.execute;
          tool.execute = async function execute(input, context) {
            if (!(await authority.owns(context.sessionID)))
              return original.call(this, input, context);
            await authority.assertCurrent(context.sessionID);
            await authority.beforeSpawn(context.sessionID, input.sessionID);
            const assertCurrent = authority.captureCurrent(context.sessionID);
            // Runtime enrollment is asynchronous; the executor wrapper checks its short-lived
            // synchronous fence after EVERY await before letting native prompt admission resume.
            let current = true;
            const abort = () => {
              current = false;
            };
            context.signal.addEventListener("abort", abort, { once: true });
            try {
              return await guardedV2SubagentExecutor(original, {
                assertCurrent: () => {
                  assertCurrent();
                  if (!current) throw new Error("V2 native guard revoked.");
                  context.signal.throwIfAborted();
                },
                beforePrompt: async (launch) => {
                  await authority.assertCurrent(context.sessionID);
                  await authority.beforePrompt(launch);
                  await authority.assertCurrent(context.sessionID);
                },
              }).call(this, input, context);
            } finally {
              context.signal.removeEventListener("abort", abort);
            }
          };
        }),
      ),
    );
    registrations.push(
      await ctx.permission.hook("evaluate", async (event) => {
        if (!(await authority.owns(event.sessionID))) return;
        await authority.assertCurrent(event.sessionID);
        clampV2ChildPermission(event, await authority.policy(event));
        await authority.assertCurrent(event.sessionID);
      }),
    );
    // Native background wakes and API resumes bypass tool spawning, but cannot bypass the
    // per-model-call Stop/owner fence. Synthetic-input correlation is still enforced by bigbud.
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        if (await authority.owns(event.sessionID)) await authority.assertCurrent(event.sessionID);
      }),
    );
  } catch (error) {
    for (const registration of registrations.toReversed()) await registration.dispose();
    throw error;
  }
  return async () => {
    for (const registration of registrations.toReversed()) await registration.dispose();
  };
}
