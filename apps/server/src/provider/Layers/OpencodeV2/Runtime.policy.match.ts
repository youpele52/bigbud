import type { PermissionRuleset } from "@opencode/client";

function normalize(value: string) {
  return value.replaceAll("\\", "/");
}

/** Pinned V2 whole-value wildcard/last-match semantics, including Windows path normalization. */
export function v2PermissionEffect(
  rules: PermissionRuleset,
  action: string,
  resource: string,
  windows = process.platform === "win32",
) {
  const matches = (pattern: string, value: string) => {
    const expression = normalize(pattern)
      .split(/([*?])/)
      .map((part) =>
        part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("");
    return new RegExp(`^${expression}$`, windows ? "i" : "").test(normalize(value));
  };
  return (
    rules.findLast((rule) => matches(rule.action, action) && matches(rule.resource, resource))
      ?.effect ?? "ask"
  );
}
