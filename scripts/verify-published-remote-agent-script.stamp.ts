import { resolveReleaseVersion } from "@bigbud/shared/releaseChannel";

/**
 * The release job stamps one `DEFAULT_VERSION` line into the published copy of
 * `scripts/release-assets/remote-agent.sh`. These helpers undo that stamp so published bytes can be
 * compared with the repository copy, and read which release a download link resolved to.
 */

const STAMP_LINE = /^DEFAULT_VERSION="([^"\n]*)" # stamped by release\.yml$/m;
const UNSTAMPED_LINE = 'DEFAULT_VERSION="" # stamped by release.yml';
const DOWNLOAD_CHANNELS = new Set(["latest", "stable", "beta", "preview", "nightly"]);

export interface NormalizedScript {
  /** The script with the stamped line reset to the repository's empty value. */
  readonly normalized: Buffer;
  /** The stamped version, `""` when unstamped, or `null` when the stamp line is missing. */
  readonly stamp: string | null;
}

export function normalizeStampedScript(bytes: Buffer): NormalizedScript {
  const text = bytes.toString("utf8");
  const match = STAMP_LINE.exec(text);
  if (!match) return { normalized: bytes, stamp: null };
  return { normalized: Buffer.from(text.replace(STAMP_LINE, UNSTAMPED_LINE)), stamp: match[1]! };
}

/** Version without the leading `v`, as stamped by release.yml. */
export function stampForTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

export function validateDownloadRef(ref: string): string {
  // Same release-version format as the download Function and the app's pinned commands.
  const valid =
    DOWNLOAD_CHANNELS.has(ref) ||
    (ref.length <= 64 && ref === ref.trim() && resolveReleaseVersion(ref) !== null);
  if (!valid) {
    throw new Error(
      `--download must be latest, stable, beta, preview, nightly or a release tag, got '${ref}'.`,
    );
  }
  return ref;
}

/** The release tag a redirect chain reached, from its `github.com/<repo>/releases/download/<tag>/` hop. */
export function resolvedReleaseTag(hops: ReadonlyArray<string>, repository: string): string | null {
  const prefix = `/${repository}/releases/download/`;
  for (const hop of hops) {
    const url = new URL(hop);
    if (url.hostname !== "github.com" || !url.pathname.startsWith(prefix)) continue;
    const [tag, asset, ...rest] = url.pathname.slice(prefix.length).split("/");
    if (tag && asset === "remote-agent.sh" && rest.length === 0) return decodeURIComponent(tag);
  }
  return null;
}
