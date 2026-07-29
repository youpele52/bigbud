import { attachCopyCommandButtons } from "../../../lib/copyText";
import {
  fetchLatestPrerelease,
  fetchLatestRelease,
  releaseChannelLabel,
  RELEASES_URL,
  resolveReleaseChannel,
} from "../../../lib/releases";

function findAsset(
  release: { assets: Array<{ name: string; browser_download_url: string }> },
  suffix: string,
) {
  if (suffix === "AppImage") {
    return release.assets.find((asset) => asset.name.endsWith(".AppImage"));
  }
  return release.assets.find((asset) => asset.name.endsWith(`-${suffix}`));
}

function populateCards(
  cards: NodeListOf<HTMLAnchorElement>,
  release: { assets: Array<{ name: string; browser_download_url: string }> },
) {
  cards.forEach((card) => {
    const suffix = card.dataset.asset;
    if (!suffix) return;
    const match = findAsset(release, suffix);
    card.href = match?.browser_download_url ?? RELEASES_URL;
  });
}

function populatePrereleaseLinks(
  links: NodeListOf<HTMLAnchorElement>,
  prerelease: {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  } | null,
) {
  const channel = prerelease ? resolveReleaseChannel(prerelease.tag_name) : null;
  links.forEach((link) => {
    if (!prerelease || !channel) {
      link.style.display = "none";
      return;
    }

    const suffix = link.dataset.asset;
    if (!suffix) return;

    const match = findAsset(prerelease, suffix);
    if (match) {
      link.href = match.browser_download_url;
      const platform = link.dataset.platform;
      link.textContent = `Download ${releaseChannelLabel(channel).toLowerCase()}${platform ? ` for ${platform}` : ""}`;
      link.style.display = "";
    } else {
      link.style.display = "none";
    }
  });
}

export async function initDownloadExperience(): Promise<void> {
  const versionLabel = document.getElementById("version-label");
  const cards = document.querySelectorAll<HTMLAnchorElement>(".download-card");
  const prereleaseLinks = document.querySelectorAll<HTMLAnchorElement>(".download-prerelease-link");
  attachCopyCommandButtons();

  try {
    const [release, prerelease] = await Promise.all([
      fetchLatestRelease(),
      fetchLatestPrerelease(),
    ]);

    if (versionLabel && release.tag_name) {
      versionLabel.textContent = `Latest (${release.tag_name})`;
    }

    populateCards(cards, release);
    populatePrereleaseLinks(prereleaseLinks, prerelease);
  } catch {
    if (versionLabel) {
      versionLabel.textContent = "Could not load release info.";
    }

    cards.forEach((card) => {
      card.href = RELEASES_URL;
    });

    prereleaseLinks.forEach((link) => {
      link.style.display = "none";
    });
  }
}
