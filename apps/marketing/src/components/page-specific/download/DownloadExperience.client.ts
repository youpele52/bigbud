import { attachCopyCommandButtons } from "../../../lib/copyText";
import { fetchLatestPrerelease, fetchLatestRelease, RELEASES_URL } from "../../../lib/releases";

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

function populateBetaLinks(
  links: NodeListOf<HTMLAnchorElement>,
  prerelease: {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  } | null,
) {
  links.forEach((link) => {
    if (!prerelease) {
      link.style.display = "none";
      return;
    }

    const suffix = link.dataset.asset;
    if (!suffix) return;

    const match = findAsset(prerelease, suffix);
    if (match) {
      link.href = match.browser_download_url;
      link.style.display = "";
    } else {
      link.style.display = "none";
    }
  });
}

export async function initDownloadExperience(): Promise<void> {
  const versionLabel = document.getElementById("version-label");
  const cards = document.querySelectorAll<HTMLAnchorElement>(".download-card");
  const betaLinks = document.querySelectorAll<HTMLAnchorElement>(".download-beta-link");
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
    populateBetaLinks(betaLinks, prerelease);
  } catch {
    if (versionLabel) {
      versionLabel.textContent = "Could not load release info.";
    }

    cards.forEach((card) => {
      card.href = RELEASES_URL;
    });

    betaLinks.forEach((link) => {
      link.style.display = "none";
    });
  }
}
