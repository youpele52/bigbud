import { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import * as Schema from "effect/Schema";

/** Legacy routing IDs remain decodable, but must never admit new runtime work. */
export const LEGACY_OPENCODE_READ_ONLY_MESSAGE =
  "This legacy OpenCode chat is read-only history. Create a new OpenCode chat to use V2; history and storage are not migrated.";
export const KILOCODE_READ_ONLY_MESSAGE =
  "KiloCode support has been removed. This chat is read-only history. Create a new chat and choose an available provider to continue.";

interface ProviderThread {
  readonly modelSelection?: { readonly provider: string } | undefined;
  readonly session?:
    | {
        readonly provider?: string | null | undefined;
        readonly providerName?: string | null | undefined;
      }
    | null
    | undefined;
}

/** Runtime retirement is independent of persisted enable preferences. */
export function isRetiredProvider(provider: string | null | undefined): boolean {
  return provider === "opencode" || provider === "kilocode";
}

export function getReadOnlyThreadProvider(
  thread: ProviderThread | null | undefined,
): string | null {
  return (
    [
      thread?.modelSelection?.provider,
      thread?.session?.provider,
      thread?.session?.providerName,
    ].find(isRetiredProvider) ?? null
  );
}

export function isReadOnlyProviderThread(thread: ProviderThread | null | undefined): boolean {
  return getReadOnlyThreadProvider(thread) !== null;
}

/** Check both persisted identities; never infer a V2 rebind. */
export function isLegacyOpencodeThread(thread: ProviderThread | null | undefined): boolean {
  return [
    thread?.modelSelection?.provider,
    thread?.session?.provider,
    thread?.session?.providerName,
  ].includes("opencode");
}

export function getProviderReadOnlyMessage(provider: string | null | undefined): string {
  return provider === "kilocode" ? KILOCODE_READ_ONLY_MESSAGE : LEGACY_OPENCODE_READ_ONLY_MESSAGE;
}

export function isActiveModelSelection(selection: unknown): selection is ModelSelection {
  return Schema.is(ModelSelection)(selection) && !isRetiredProvider(selection.provider);
}

/** Runtime boundaries must reject saved retired selections instead of replacing them. */
export function requireActiveModelSelection(selection: unknown): ModelSelection {
  if (isActiveModelSelection(selection)) return selection;
  throw new Error("Choose an available provider and model before continuing.");
}
