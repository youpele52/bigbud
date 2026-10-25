import type { PermissionRuleset } from "@opencode/client";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";

type Effect = "allow" | "ask" | "deny";
const rank: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };

/** Independent evaluations, never append a broad parent allow after stricter agent/session rules. */
export function v2ChildPermissionCeiling(input: {
  readonly action: string;
  readonly resources: readonly string[];
  readonly nativeEffect: Effect;
  readonly parent: PermissionRuleset;
  readonly agent: PermissionRuleset;
  readonly overlay: PermissionRuleset;
}): Effect {
  if (
    !input.action ||
    rank[input.nativeEffect] === undefined ||
    !input.resources.length ||
    input.resources.length > 128 ||
    input.resources.some((resource) => !resource || resource.length > 4096)
  )
    return "deny";
  let result = input.nativeEffect;
  for (const resource of input.resources)
    for (const [rules, fallback] of [
      [input.parent, "deny"],
      [input.agent, "ask"],
      [input.overlay, "allow"],
    ] as const) {
      // Unknown policy coverage is a denial, not a native default grant.
      const effect = v2PermissionEffect(
        [{ action: "*", resource: "*", effect: fallback }, ...rules],
        input.action,
        resource,
      );
      if (rank[effect] > rank[result]) result = effect;
    }
  return result;
}
