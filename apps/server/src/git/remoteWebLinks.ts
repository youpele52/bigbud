import type { GitBranchWebLink } from "@bigbud/contracts/workspace/git.domain.ts";

type SupportedProvider = GitBranchWebLink["provider"];

interface ParsedRemoteRepository {
  provider: SupportedProvider;
  repositoryUrl: string;
}

const SUPPORTED_HOSTS: Readonly<Record<string, SupportedProvider>> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
};

function normalizeRepositoryPath(path: string, provider: SupportedProvider): string | null {
  const normalized = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = normalized.split("/");

  if (
    segments.length < 2 ||
    (provider === "github" && segments.length !== 2) ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || /[\\?#\s]/.test(segment),
    )
  ) {
    return null;
  }

  return segments.join("/");
}

function parseUrlRemote(remoteUrl: string): { host: string; path: string } | null {
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }

  if (url.search || url.hash || url.port) return null;
  if (url.protocol === "https:") {
    if (url.username || url.password) return null;
  } else if (url.protocol === "ssh:") {
    if (url.username !== "git" || url.password) return null;
  } else if (url.protocol === "git:") {
    if (url.username || url.password) return null;
  } else {
    return null;
  }

  return { host: url.hostname.toLowerCase(), path: url.pathname };
}

function parseRemoteRepository(remoteUrl: string): ParsedRemoteRepository | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;

  const scpMatch = /^git@([^:]+):(.+)$/.exec(trimmed);
  const parsed = scpMatch
    ? { host: (scpMatch[1] ?? "").toLowerCase(), path: scpMatch[2] ?? "" }
    : parseUrlRemote(trimmed);
  if (!parsed) return null;

  const provider = SUPPORTED_HOSTS[parsed.host];
  if (!provider) return null;
  const repositoryPath = normalizeRepositoryPath(parsed.path, provider);
  if (!repositoryPath) return null;

  return {
    provider,
    repositoryUrl: `https://${parsed.host}/${repositoryPath}`,
  };
}

export function buildRemoteWebLinks(remoteUrl: string, branchRef: string): GitBranchWebLink | null {
  const repository = parseRemoteRepository(remoteUrl);
  if (!repository || branchRef.length === 0) return null;

  const branchPath = repository.provider === "github" ? "tree" : "-/tree";
  return {
    ...repository,
    branchUrl: `${repository.repositoryUrl}/${branchPath}/${encodeURIComponent(branchRef)}`,
  };
}
