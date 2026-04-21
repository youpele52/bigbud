/**
 * Keybindings Compiler - Schema transformations, rule compilation, and merge utilities.
 *
 * @module KeybindingsCompiler
 */
import {
  KeybindingRule,
  MAX_KEYBINDINGS_COUNT,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
} from "@bigbud/contracts";
import { Mutable } from "effect/Types";
import { Effect, Option, Predicate, Schema, SchemaIssue, SchemaTransformation } from "effect";
import {
  encodeShortcut,
  encodeWhenAst,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
} from "./keybindings.parser";

/** @internal - Exported for testing */
export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;

  if (rule.when !== undefined) {
    const whenAst = parseKeybindingWhenExpression(rule.when);
    if (!whenAst) return null;
    return {
      command: rule.command,
      shortcut,
      whenAst,
    };
  }

  return {
    command: rule.command,
    shortcut,
  };
}

export function compileResolvedKeybindingsConfig(
  config: readonly KeybindingRule[],
): ResolvedKeybindingsConfig {
  const compiled: Mutable<ResolvedKeybindingsConfig> = [];
  for (const rule of config) {
    const result = Schema.decodeExit(ResolvedKeybindingFromConfig)(rule);
    if (result._tag === "Success") {
      compiled.push(result.value);
    }
  }
  return compiled;
}

export const ResolvedKeybindingFromConfig = KeybindingRule.pipe(
  Schema.decodeTo(
    Schema.toType(ResolvedKeybindingRule),
    SchemaTransformation.transformOrFail({
      decode: (rule) =>
        Effect.succeed(compileResolvedKeybindingRule(rule)).pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () =>
              new SchemaIssue.InvalidValue(Option.some(rule), {
                title: "Invalid keybinding rule",
              }),
          ),
          Effect.map((resolved) => resolved),
        ),

      encode: (resolved) =>
        Effect.gen(function* () {
          const key = encodeShortcut(resolved.shortcut);
          if (!key) {
            return yield* Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(resolved), {
                title: "Resolved shortcut cannot be encoded to key string",
              }),
            );
          }

          const when = resolved.whenAst ? encodeWhenAst(resolved.whenAst) : undefined;
          return {
            key,
            command: resolved.command,
            when,
          };
        }),
    }),
  ),
);

export const ResolvedKeybindingsFromConfig = Schema.Array(ResolvedKeybindingFromConfig).check(
  Schema.isMaxLength(MAX_KEYBINDINGS_COUNT),
);

export function isSameKeybindingRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return (
    left.command === right.command &&
    left.key === right.key &&
    (left.when ?? undefined) === (right.when ?? undefined)
  );
}

function keybindingShortcutContext(rule: KeybindingRule): string | null {
  const parsed = parseKeybindingShortcut(rule.key);
  if (!parsed) return null;
  const encoded = encodeShortcut(parsed);
  if (!encoded) return null;
  return `${encoded}\u0000${rule.when ?? ""}`;
}

export function hasSameShortcutContext(left: KeybindingRule, right: KeybindingRule): boolean {
  const leftContext = keybindingShortcutContext(left);
  const rightContext = keybindingShortcutContext(right);
  if (!leftContext || !rightContext) return false;
  return leftContext === rightContext;
}

export function mergeWithDefaultKeybindings(
  defaultResolved: ResolvedKeybindingsConfig,
  custom: ResolvedKeybindingsConfig,
): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...defaultResolved];
  }

  const overriddenCommands = new Set(custom.map((binding) => binding.command));
  const retainedDefaults = defaultResolved.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  const merged = [...retainedDefaults, ...custom];

  if (merged.length <= MAX_KEYBINDINGS_COUNT) {
    return merged;
  }

  // Keep the latest rules when the config exceeds max size; later rules have higher precedence.
  return merged.slice(-MAX_KEYBINDINGS_COUNT);
}
