/**
 * Provider provisioning recipes (P7 increment 5, WP-5A).
 *
 * A recipe is data plus small pure functions. It describes what a provider needs on a host,
 * who supplies each piece, how bigbud finds an existing install and which existing readiness
 * check owns authentication. Recipes never install anything; the provisioning action (WP-5C)
 * reads them. Decision 6: bigbud provisions only Copilot and the Pi closure. Every other
 * provider reuses a user-installed tool and shows exact manual commands. No vendor installer
 * scripts are run by bigbud.
 */
import type { SELECTABLE_PROVIDER_KINDS } from "@bigbud/contracts/constants/provider.constant.ts";

export type SelectableProviderKind = (typeof SELECTABLE_PROVIDER_KINDS)[number];

export type RecipeOs = "linux" | "darwin" | "win32";
export type RecipeArch = "x64" | "arm64";
/** `none` is used for non-Linux hosts, where libc does not select an artifact. */
export type RecipeLibc = "glibc" | "musl" | "none";

export interface PlatformTuple {
  readonly os: RecipeOs;
  readonly arch: RecipeArch;
  readonly libc: RecipeLibc;
}

/** Decision 3: the remote backend tier (and so the graph closure) is glibc Linux only. */
export const BACKEND_GRAPH_TUPLES: ReadonlyArray<PlatformTuple> = [
  { os: "linux", arch: "x64", libc: "glibc" },
  { os: "linux", arch: "arm64", libc: "glibc" },
];

/** Integrity evidence for one component. User-managed tools are never verified by bigbud. */
export type RecipeIntegrity =
  | {
      readonly kind: "sri";
      /** Resolves the audited pin for a tuple, or undefined when the tuple has no pin. */
      readonly resolve: (tuple: PlatformTuple) => PinnedArtifact | undefined;
    }
  | { readonly kind: "backendGraph" }
  | { readonly kind: "serverBundle" }
  | { readonly kind: "userManaged" };

export interface PinnedArtifact {
  readonly version: string;
  readonly url: string;
  /** Subresource-integrity string, e.g. `sha512-…`. */
  readonly integrity: string;
  readonly archiveBytes: number;
  readonly unpackedBytes: number;
}

/** How an executable is found. Explicit configured paths always win over discovery. */
export interface ExecutableDiscovery {
  /**
   * Dotted settings key holding the explicit path, e.g. `providers.codex.binaryPath`, or null
   * when bigbud has no explicit-path setting for this executable.
   */
  readonly settingsKey: string | null;
  /** Command names searched on the discovered service PATH, in order. */
  readonly commandNames: ReadonlyArray<string>;
  /** True when the tool is normally installed in a user PATH (nvm, Homebrew, ~/.local/bin…). */
  readonly usesServicePath: boolean;
}

export interface NativePrerequisite {
  readonly id: string;
  /** What is loaded, e.g. a shared library soname. */
  readonly requirement: string;
  /** Whether the provider still runs (degraded) when the prerequisite is missing. */
  readonly optional: boolean;
  readonly note: string;
}

export type RecipeComponent =
  | {
      /** Inlined into the bigbud server bundle; nothing to fetch. */
      readonly kind: "bundled";
      readonly id: string;
      readonly description: string;
      readonly packages: ReadonlyArray<string>;
      readonly integrity: { readonly kind: "serverBundle" };
    }
  | {
      /** Shipped as an external package inside the signed backend graph closure. */
      readonly kind: "graphExternal";
      readonly id: string;
      readonly description: string;
      readonly packages: ReadonlyArray<string>;
      readonly tuples: ReadonlyArray<PlatformTuple>;
      readonly nativePrerequisites: ReadonlyArray<NativePrerequisite>;
      readonly integrity: { readonly kind: "backendGraph" };
    }
  | {
      /** A separate vendor executable or service process. */
      readonly kind: "vendorExecutable";
      readonly id: string;
      readonly description: string;
      /** `bigbud` only for decision-6 providers with a pinned artifact. */
      readonly suppliedBy: "bigbud" | "user";
      /** Pinned tuples for bigbud-supplied artifacts; `userManaged` for user tools. */
      readonly tuples: ReadonlyArray<PlatformTuple> | "userManaged";
      readonly discovery: ExecutableDiscovery;
      readonly integrity: RecipeIntegrity;
    };

/**
 * Reference to the provider's existing readiness/auth check. The recipe never re-implements
 * authentication; the module is referenced by path so recipes do not import provider SDKs.
 */
export interface AuthReadinessReference {
  /** Path relative to `apps/server/src`. */
  readonly module: string;
  readonly exportName: string;
  /** The manual step the user runs on the host; bigbud never signs in for the user. */
  readonly userStep: string;
}

export interface ManualFallback {
  readonly vendor: string;
  /** Exact commands, or a single "See vendor docs" line when no command is established. */
  readonly installCommands: ReadonlyArray<string>;
  readonly docsUrl?: string;
}

export interface ProviderRecipe {
  readonly kind: SelectableProviderKind;
  readonly displayName: string;
  /** Decision 6: `bigbud` for Copilot and Pi only. */
  readonly provisionedBy: "bigbud" | "user";
  readonly components: ReadonlyArray<RecipeComponent>;
  readonly authReadiness: AuthReadinessReference;
  readonly manual: ManualFallback;
  readonly notes: ReadonlyArray<string>;
}

export const VENDOR_DOCS_PREFIX = "See vendor docs";

export function platformTupleKey(tuple: PlatformTuple): string {
  return `${tuple.os}-${tuple.arch}-${tuple.libc}`;
}

function sameTuple(left: PlatformTuple, right: PlatformTuple): boolean {
  return left.os === right.os && left.arch === right.arch && left.libc === right.libc;
}

/** Native prerequisites declared by all graph components of a recipe. */
export function recipePrerequisites(recipe: ProviderRecipe): ReadonlyArray<NativePrerequisite> {
  return recipe.components.flatMap((component) =>
    component.kind === "graphExternal" ? component.nativePrerequisites : [],
  );
}

/**
 * Whether bigbud can supply every bigbud-owned component for the tuple. User-supplied
 * components never block, because the user's own install decides the platform.
 */
export function recipeSupportsTuple(recipe: ProviderRecipe, tuple: PlatformTuple): boolean {
  return recipe.components.every((component) => {
    if (component.kind === "bundled") return true;
    if (component.kind === "graphExternal") {
      return component.tuples.some((candidate) => sameTuple(candidate, tuple));
    }
    if (component.tuples === "userManaged") return true;
    return component.tuples.some((candidate) => sameTuple(candidate, tuple));
  });
}

/** Human-readable manual setup text: install commands, then the auth step. */
export function formatManualFallback(recipe: ProviderRecipe): string {
  const lines = [`${recipe.displayName} (${recipe.manual.vendor})`];
  for (const command of recipe.manual.installCommands) lines.push(`  ${command}`);
  if (recipe.manual.docsUrl) lines.push(`  Docs: ${recipe.manual.docsUrl}`);
  lines.push(`  Sign in: ${recipe.authReadiness.userStep}`);
  return lines.join("\n");
}

const SETTINGS_KEY_PATTERN = /^providers\.[A-Za-z0-9]+\.[A-Za-z]+$/;
const DECISION_SIX_PROVISIONED: ReadonlySet<SelectableProviderKind> = new Set(["copilot", "pi"]);

/** Shape validation used by tests and by WP-5C before acting on a recipe. */
export function validateRecipe(recipe: ProviderRecipe): ReadonlyArray<string> {
  const issues: string[] = [];
  const expectBigbud = DECISION_SIX_PROVISIONED.has(recipe.kind);
  if ((recipe.provisionedBy === "bigbud") !== expectBigbud) {
    issues.push(`${recipe.kind}: provisionedBy must follow decision 6`);
  }
  if (recipe.components.length === 0) issues.push(`${recipe.kind}: no components`);
  const ids = new Set<string>();
  for (const component of recipe.components) {
    if (ids.has(component.id)) issues.push(`${recipe.kind}: duplicate component ${component.id}`);
    ids.add(component.id);
    if (component.kind === "graphExternal" && component.tuples.length === 0) {
      issues.push(`${recipe.kind}: graph component ${component.id} has no tuples`);
    }
    if (component.kind !== "vendorExecutable") continue;
    if (component.discovery.commandNames.length === 0) {
      issues.push(`${recipe.kind}: ${component.id} has no command names`);
    }
    const settingsKey = component.discovery.settingsKey;
    if (settingsKey !== null && !SETTINGS_KEY_PATTERN.test(settingsKey)) {
      issues.push(`${recipe.kind}: ${component.id} has an invalid settings key`);
    }
    const bigbudSupplied = component.suppliedBy === "bigbud";
    if (bigbudSupplied && !expectBigbud) {
      issues.push(`${recipe.kind}: ${component.id} cannot be bigbud-supplied (decision 6)`);
    }
    if (bigbudSupplied && (component.tuples === "userManaged" || component.tuples.length === 0)) {
      issues.push(`${recipe.kind}: ${component.id} is bigbud-supplied without pinned tuples`);
    }
    if (bigbudSupplied && component.integrity.kind !== "sri") {
      issues.push(`${recipe.kind}: ${component.id} is bigbud-supplied without an SRI pin`);
    }
    if (!bigbudSupplied && component.integrity.kind !== "userManaged") {
      issues.push(`${recipe.kind}: ${component.id} is user-supplied but claims bigbud integrity`);
    }
    if (
      bigbudSupplied &&
      component.integrity.kind === "sri" &&
      component.tuples !== "userManaged"
    ) {
      for (const tuple of component.tuples) {
        const pin = component.integrity.resolve(tuple);
        if (!pin || !/^sha(256|384|512)-[A-Za-z0-9+/]+=*$/.test(pin.integrity)) {
          issues.push(`${recipe.kind}: ${component.id} lacks a pin for ${platformTupleKey(tuple)}`);
        } else if (!pin.url.startsWith("https://")) {
          issues.push(`${recipe.kind}: ${component.id} pin URL must be https`);
        }
      }
    }
  }
  if (recipe.manual.installCommands.length === 0) {
    issues.push(`${recipe.kind}: manual fallback has no install text`);
  }
  for (const command of recipe.manual.installCommands) {
    if (/\|\s*(ba|z)?sh\b/.test(command)) {
      issues.push(`${recipe.kind}: manual fallback pipes a vendor installer script into a shell`);
    }
  }
  if (recipe.manual.docsUrl !== undefined && !recipe.manual.docsUrl.startsWith("https://")) {
    issues.push(`${recipe.kind}: docs URL must be https`);
  }
  if (!recipe.authReadiness.module.endsWith(".ts") || !recipe.authReadiness.exportName) {
    issues.push(`${recipe.kind}: auth readiness reference is incomplete`);
  }
  if (!recipe.authReadiness.userStep.trim()) issues.push(`${recipe.kind}: auth step is empty`);
  return issues;
}

/** A user-installed vendor executable that bigbud only discovers and never verifies. */
export function userExecutable(input: {
  readonly id: string;
  readonly description: string;
  readonly settingsKey: string | null;
  readonly commandNames: ReadonlyArray<string>;
}): RecipeComponent {
  return {
    kind: "vendorExecutable",
    id: input.id,
    description: input.description,
    suppliedBy: "user",
    tuples: "userManaged",
    discovery: {
      settingsKey: input.settingsKey,
      commandNames: input.commandNames,
      usesServicePath: true,
    },
    integrity: { kind: "userManaged" },
  };
}

/** An SDK or adapter inlined into the server bundle. */
export function bundledComponent(input: {
  readonly id: string;
  readonly description: string;
  readonly packages: ReadonlyArray<string>;
}): RecipeComponent {
  return { kind: "bundled", ...input, integrity: { kind: "serverBundle" } };
}
