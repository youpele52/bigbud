import { createHash } from "node:crypto";
import {
  APPROVAL_INTENT_MAX_CHARS,
  type ApprovalExecutionIntent,
} from "@bigbud/contracts/orchestration/approvalIntent.ts";

function compareKeysDescending(left: string, right: string) {
  return left < right ? 1 : left > right ? -1 : 0;
}

/** Build complete JSON only within the published bound; never stringify an entire oversized request first. */
export function boundedV2ApprovalIntent(value: unknown): ApprovalExecutionIntent | undefined {
  const chunks: string[] = [];
  let size = 0;
  const append = (text: string) => {
    size += text.length;
    if (size > APPROVAL_INTENT_MAX_CHARS) throw new Error("intent bound");
    chunks.push(text);
  };
  const string = (text: string) => {
    if (text.length > APPROVAL_INTENT_MAX_CHARS - size) throw new Error("intent bound");
    append(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number) => {
    if (depth > 32) throw new Error("intent depth");
    if (typeof item === "string") return string(item);
    if (item === null || item === undefined) return append("null");
    if (typeof item === "number" || typeof item === "boolean") return append(JSON.stringify(item));
    if (typeof item !== "object") throw new Error("intent value");
    const array = Array.isArray(item);
    append(array ? "[" : "{");
    let first = true;
    for (const [key, child] of Object.entries(item)) {
      if (!array && child === undefined) continue;
      if (!first) append(",");
      first = false;
      if (!array) {
        string(key);
        append(":");
      }
      visit(child, depth + 1);
    }
    append(array ? "]" : "}");
  };
  try {
    visit(value, 0);
    return { format: "json", content: chunks.join("") };
  } catch {
    return undefined;
  }
}

/** Compare native request snapshots without allocating whole oversized JSON documents. */
export function v2PermissionFingerprint(value: unknown) {
  const hash = createHash("sha256");
  type Part = { kind: "value"; value: unknown } | { kind: "key"; value: string } | { kind: "end" };
  const pending: Part[] = [{ kind: "value", value }];
  while (pending.length) {
    const part = pending.pop()!;
    if (part.kind === "end") {
      hash.update("end:");
      continue;
    }
    if (part.kind === "key") {
      hash.update(`${part.value.length}:${part.value}`);
      continue;
    }
    const item = part.value;
    if (item !== null && typeof item === "object") {
      hash.update(Array.isArray(item) ? "array:" : "object:");
      pending.push({ kind: "end" });
      for (const key of Object.keys(item).toSorted(compareKeysDescending)) {
        pending.push(
          { kind: "value", value: (item as Record<string, unknown>)[key] },
          { kind: "key", value: key },
        );
      }
    } else {
      const text = String(item);
      hash.update(`${typeof item}:${text.length}:`);
      hash.update(text);
    }
  }
  return hash.digest("hex");
}
