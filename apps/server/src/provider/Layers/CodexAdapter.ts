/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps `CodexAppServerManager` behind the `CodexAdapter` service contract and
 * maps manager failures into the shared `ProviderAdapterError` algebra.
 *
 * @module CodexAdapterLive
 */
import { Layer } from "effect";

import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { makeCodexAdapter } from "./CodexAdapter.session.ts";
import type { CodexAdapterLiveOptions } from "./CodexAdapter.types.ts";

export type { CodexAdapterLiveOptions } from "./CodexAdapter.types.ts";

export const CodexAdapterLive = Layer.effect(CodexAdapter, makeCodexAdapter());

export function makeCodexAdapterLive(options?: CodexAdapterLiveOptions) {
  return Layer.effect(CodexAdapter, makeCodexAdapter(options));
}
