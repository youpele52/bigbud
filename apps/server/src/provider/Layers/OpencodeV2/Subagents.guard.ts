import type { PermissionRuleset } from "@opencode/client";
import type { V2ChildLaunch } from "./Runtime.family.ts";
import { v2ChildPermissionCeiling } from "./Subagents.ceiling.ts";

export const V2_SUBAGENT_GUARD_ABI = "bigbud.native-subagents.v1";
interface NativeContext {
  readonly sessionID: string;
  readonly messageID: string;
  readonly id: string;
  readonly signal: AbortSignal;
  readonly progress: (metadata: Record<string, unknown>) => Promise<void>;
}
interface NativeInput {
  readonly agent: string;
  readonly description: string;
  readonly prompt: string;
  readonly sessionID?: string;
  readonly background?: boolean;
}

/** Wraps the pinned native executor, preserving input/output/errors/receiver and awaited progress ABI. */
export function guardedV2SubagentExecutor<I extends NativeInput, O>(
  execute: (input: I, context: NativeContext) => Promise<O>,
  authority: {
    readonly assertCurrent: () => void;
    readonly beforePrompt: (launch: V2ChildLaunch) => Promise<void>;
  },
) {
  return async function guarded(this: unknown, input: I, context: NativeContext): Promise<O> {
    authority.assertCurrent();
    context.signal.throwIfAborted();
    let enrolled: string | undefined;
    const progress = async (metadata: Record<string, unknown>) => {
      authority.assertCurrent();
      context.signal.throwIfAborted();
      if (metadata.sessionID !== undefined) {
        if (
          typeof metadata.sessionID !== "string" ||
          !metadata.sessionID ||
          (enrolled && enrolled !== metadata.sessionID)
        )
          throw new Error("V2 native child progress identity changed.");
        await authority.beforePrompt({
          sessionID: metadata.sessionID,
          parentSessionID: context.sessionID,
          messageID: context.messageID,
          callID: context.id,
          agent: input.agent,
          description: input.description,
          prompt: input.prompt,
          background: input.background === true,
        });
        authority.assertCurrent();
        context.signal.throwIfAborted();
        enrolled = metadata.sessionID;
      }
      await context.progress(metadata);
      authority.assertCurrent();
      context.signal.throwIfAborted();
    };
    return execute.call(this, input, { ...context, progress });
  };
}

/** Register only on a stack qualified to keep this clamp final; public hooks alone cannot prove that. */
export function clampV2ChildPermission(
  event: { action: string; resources: readonly string[]; effect: "allow" | "ask" | "deny" },
  policy: { parent: PermissionRuleset; agent: PermissionRuleset; overlay: PermissionRuleset },
) {
  event.effect = v2ChildPermissionCeiling({
    ...policy,
    action: event.action,
    resources: event.resources,
    nativeEffect: event.effect,
  });
}
