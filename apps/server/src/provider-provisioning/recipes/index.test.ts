import { readFileSync } from "node:fs";
import * as Path from "node:path";

import { SELECTABLE_PROVIDER_KINDS } from "@bigbud/contracts/constants/provider.constant.ts";
import { describe, expect, it } from "vitest";

import {
  BACKEND_GRAPH_TUPLES,
  formatManualFallback,
  type ProviderRecipe,
  recipePrerequisites,
  recipeSupportsTuple,
  validateRecipe,
} from "../recipe.ts";
import { copilotRecipe, resolveCopilotCliPin } from "./copilot.ts";
import { PROVIDER_RECIPES, resolveProviderRecipe } from "./index.ts";

const SERVER_SRC = Path.resolve(import.meta.dirname, "../..");

describe("recipes_cover_selectable_kinds", () => {
  it.each([...SELECTABLE_PROVIDER_KINDS])("has a recipe for %s", (kind) => {
    const recipe = resolveProviderRecipe(kind);
    expect(recipe, `missing provisioning recipe for selectable kind ${kind}`).toBeDefined();
    expect(recipe?.kind).toBe(kind);
  });

  it("has no recipe for kinds that are not selectable", () => {
    expect(Object.keys(PROVIDER_RECIPES).toSorted()).toEqual(
      [...SELECTABLE_PROVIDER_KINDS].toSorted(),
    );
    expect(resolveProviderRecipe("opencode")).toBeUndefined();
    expect(resolveProviderRecipe("toString")).toBeUndefined();
  });
});

describe("recipe shape validation", () => {
  it.each([...SELECTABLE_PROVIDER_KINDS])("%s recipe is valid", (kind) => {
    expect(validateRecipe(PROVIDER_RECIPES[kind])).toEqual([]);
  });

  it("follows decision 6: bigbud provisions only Copilot and Pi", () => {
    const provisioned = SELECTABLE_PROVIDER_KINDS.filter(
      (kind) => PROVIDER_RECIPES[kind].provisionedBy === "bigbud",
    );
    expect(provisioned.toSorted()).toEqual(["copilot", "pi"]);
  });

  it.each([...SELECTABLE_PROVIDER_KINDS])("%s auth reference names a real export", (kind) => {
    const { module, exportName } = PROVIDER_RECIPES[kind].authReadiness;
    const source = readFileSync(Path.join(SERVER_SRC, module), "utf8");
    expect(source).toMatch(new RegExp(`export (const|function|async function) ${exportName}\\b`));
  });

  it("rejects recipes that break the rules", () => {
    const broken: ProviderRecipe = {
      ...PROVIDER_RECIPES.codex,
      provisionedBy: "bigbud",
      components: [],
      manual: { vendor: "x", installCommands: ["curl https://example.invalid/i | sh"] },
      authReadiness: { module: "x.js", exportName: "", userStep: " " },
    };
    const issues = validateRecipe(broken);
    expect(issues.join("\n")).toMatch(/decision 6/);
    expect(issues.join("\n")).toMatch(/no components/);
    expect(issues.join("\n")).toMatch(/vendor installer script/);
    expect(issues.join("\n")).toMatch(/auth readiness reference is incomplete/);
    expect(issues.join("\n")).toMatch(/auth step is empty/);
  });

  it("rejects a bigbud-supplied component without a pin for a declared tuple", () => {
    const [sdk, cli] = copilotRecipe.components;
    if (!sdk || cli?.kind !== "vendorExecutable") throw new Error("unexpected copilot shape");
    const unpinned: ProviderRecipe = {
      ...copilotRecipe,
      components: [sdk, { ...cli, tuples: [{ os: "linux", arch: "x64", libc: "none" }] }],
    };
    expect(validateRecipe(unpinned).join("\n")).toMatch(/lacks a pin for linux-x64-none/);
  });
});

describe("recipe functions", () => {
  it("resolves Copilot pins from the audited release table", () => {
    const pin = resolveCopilotCliPin({ os: "linux", arch: "arm64", libc: "glibc" });
    expect(pin?.url).toBe(
      "https://registry.npmjs.org/@github/copilot-linux-arm64/-/copilot-linux-arm64-1.0.105.tgz",
    );
    expect(pin?.integrity).toMatch(/^sha512-/);
    expect(resolveCopilotCliPin({ os: "linux", arch: "arm64", libc: "musl" })?.url).toContain(
      "copilot-linuxmusl-arm64",
    );
  });

  it("supports only backend graph tuples for bigbud-provisioned recipes", () => {
    for (const tuple of BACKEND_GRAPH_TUPLES) {
      expect(recipeSupportsTuple(PROVIDER_RECIPES.pi, tuple)).toBe(true);
      expect(recipeSupportsTuple(PROVIDER_RECIPES.copilot, tuple)).toBe(true);
    }
    const musl = { os: "linux", arch: "x64", libc: "musl" } as const;
    expect(recipeSupportsTuple(PROVIDER_RECIPES.pi, musl)).toBe(false);
    // User tools never block on platform: the user's install decides.
    expect(recipeSupportsTuple(PROVIDER_RECIPES.codex, musl)).toBe(true);
  });

  it("reports Pi's X11 prerequisite and formats manual text", () => {
    expect(recipePrerequisites(PROVIDER_RECIPES.pi).map((item) => item.requirement)).toEqual([
      "libxcb.so.1",
    ]);
    const text = formatManualFallback(PROVIDER_RECIPES.claudeAgent);
    expect(text).toContain("npm install -g @anthropic-ai/claude-code");
    expect(text).toContain("Sign in: claude auth login");
  });
});
