import path from "node:path";
import { Schema } from "effect";
import type { OpencodeV2Client } from "./Client.ts";
import { fromLenientJson } from "@bigbud/shared/schemaJson";
import { readV2NativePluginFile } from "./PluginSetup.fs.ts";
import { V2_THREAD_RPC, V2_THREAD_ACTIONS } from "./Orchestration.protocol.ts";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import type { V2ThreadRegistration } from "./Orchestration.registration.ts";

const parse = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));
const pattern = (expression: string, value: string) =>
  new RegExp(
    `^${expression
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  ).test(value);

export function assertV2PluginRegistrationEnabled(configured: readonly string[], id: string) {
  if (configured.some((entry) => entry.startsWith("-") && pattern(entry.slice(1), id)))
    throw new Error("V2 required native family plugin is explicitly disabled; no setup override.");
}

/** Parse only to validate/control installation; no JSONC serialization, credential copying or config writes. */
export async function inspectV2PluginControls(
  entries: Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>,
  root: string,
  authority: V2PluginSetupAuthority,
  directory: string,
  machinePaths: ReadonlySet<string> = new Set(),
  registration?: V2ThreadRegistration,
) {
  const documents: Array<{ info: Record<string, unknown>; filename?: string }> = [];
  const filenames = new Set([path.join(root, "opencode.json"), path.join(root, "opencode.jsonc")]);
  for (const entry of entries)
    if (entry.type === "document") {
      documents.push({
        info: entry.info as unknown as Record<string, unknown>,
        ...(entry.path ? { filename: entry.path } : {}),
      });
      if (entry.path && !machinePaths.has(entry.path)) filenames.add(entry.path);
    }
  if (filenames.size > 128)
    throw new Error("V2 automatic plugin config-source inventory exceeds its bound.");
  let total = 0;
  for (const filename of filenames) {
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    const source = await readV2NativePluginFile(filename, false);
    authority.assertCurrent();
    authority.signal.throwIfAborted();
    if (!source) continue;
    total += Buffer.byteLength(source.content);
    if (total > 4194304) throw new Error("V2 automatic plugin config-source byte bound exceeded.");
    let decoded: unknown;
    try {
      decoded = parse(source.content);
    } catch {
      throw new Error(
        "V2 native JSON/JSONC configuration is malformed/truncated; automatic setup will not modify it.",
      );
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw new Error("V2 native configuration document is not an object; no setup writes.");
    documents.push({ info: decoded as Record<string, unknown>, filename });
  }
  const configured: string[] = [];
  for (const document of documents) {
    const plugins = document.info.plugins ?? document.info.plugin;
    if (plugins !== undefined && !Array.isArray(plugins))
      throw new Error("V2 native plugin controls are malformed; no setup writes.");
    for (const item of (plugins ?? []) as unknown[]) {
      const entry =
        typeof item === "string"
          ? item
          : item && typeof item === "object" && "package" in item
            ? item.package
            : undefined;
      if (typeof entry !== "string")
        throw new Error(
          "V2 native plugin entry cannot be safely interpreted; legacy entries were not rewritten.",
        );
      if (
        entry.startsWith("-") &&
        [V2_THREAD_RPC, ...(registration ? [registration.id] : [])].some((id) =>
          pattern(entry.slice(1), id),
        )
      )
        throw new Error(
          "V2 required plugin is explicitly removed/denied by native configuration. Automatic setup will not override that policy.",
        );
      configured.push(entry);
      if (entry.startsWith(".") || path.isAbsolute(entry))
        configured.push(
          path.resolve(document.filename ? path.dirname(document.filename) : directory, entry),
        );
    }
  }
  // The qualified API supplies canonical rules, including normalization of compatible legacy shapes.
  const rules = entries.flatMap((entry) =>
    entry.type === "document" ? (entry.info.permissions ?? []) : [],
  );
  for (const name of [
    ...V2_THREAD_ACTIONS.map((action) => `bigbud_thread_v1_${action}`),
    ...(registration?.tools ?? []),
  ])
    if (v2PermissionEffect(rules, name, "*") === "deny")
      throw new Error(
        "V2 required canonical tool is explicitly denied by native permissions; no grants or setup override.",
      );
  return configured;
}
