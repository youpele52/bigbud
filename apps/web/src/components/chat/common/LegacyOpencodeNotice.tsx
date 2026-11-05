import { RetiredProviderNotice } from "./RetiredProviderNotice";

/** Preserve the legacy OpenCode notice API for existing history surfaces. */
export function LegacyOpencodeNotice({
  threadId = "legacy-opencode",
}: {
  readonly threadId?: string;
}) {
  return <RetiredProviderNotice threadId={threadId} provider="opencode" />;
}
