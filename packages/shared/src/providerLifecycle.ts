/** Legacy routing IDs remain decodable, but must never admit new runtime work. */
export const LEGACY_OPENCODE_READ_ONLY_MESSAGE =
  "This legacy OpenCode chat is read-only history. Create a new OpenCode chat to use V2; history and storage are not migrated.";

/** Runtime retirement is independent of persisted enable preferences. */
export function isRetiredProvider(provider: string | null | undefined): boolean {
  return provider === "opencode";
}

/** Check both persisted selection and session identity; never infer a V2 rebind. */
export function isLegacyOpencodeThread(
  thread:
    | {
        readonly modelSelection?: { readonly provider: string } | undefined;
        readonly session?:
          | {
              readonly provider?: string | null | undefined;
              readonly providerName?: string | null | undefined;
            }
          | null
          | undefined;
      }
    | null
    | undefined,
): boolean {
  return (
    isRetiredProvider(thread?.modelSelection?.provider) ||
    isRetiredProvider(thread?.session?.provider) ||
    isRetiredProvider(thread?.session?.providerName)
  );
}
