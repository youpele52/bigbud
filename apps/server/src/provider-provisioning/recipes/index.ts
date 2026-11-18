import type { ProviderRecipe, SelectableProviderKind } from "../recipe.ts";
import { claudeAgentRecipe } from "./claudeAgent.ts";
import { cliProxyRecipe } from "./cliProxy.ts";
import { codexRecipe } from "./codex.ts";
import { copilotRecipe } from "./copilot.ts";
import { cursorRecipe } from "./cursor.ts";
import { devinRecipe } from "./devin.ts";
import { museRecipe } from "./muse.ts";
import { opencodeV2Recipe } from "./opencodeV2.ts";
import { piRecipe } from "./pi.ts";

/** Exhaustive by type: adding a selectable kind fails typecheck until it has a recipe. */
export const PROVIDER_RECIPES: { readonly [K in SelectableProviderKind]: ProviderRecipe } = {
  codex: codexRecipe,
  claudeAgent: claudeAgentRecipe,
  cliProxy: cliProxyRecipe,
  copilot: copilotRecipe,
  cursor: cursorRecipe,
  devin: devinRecipe,
  muse: museRecipe,
  opencodeV2: opencodeV2Recipe,
  pi: piRecipe,
};

/** Returns the recipe for a selectable provider, or undefined for retired/unknown kinds. */
export function resolveProviderRecipe(kind: string): ProviderRecipe | undefined {
  if (!Object.hasOwn(PROVIDER_RECIPES, kind)) return undefined;
  return PROVIDER_RECIPES[kind as SelectableProviderKind];
}
