import { attachCopyCommandButtons } from "../../../lib/copyText";
import { fetchLatestRelease, RELEASES_URL } from "../../../lib/releases";

export async function initDownloadExperience(): Promise<void> {
  const versionLabel = document.getElementById("version-label");
  const cards = document.querySelectorAll<HTMLAnchorElement>(".download-card");
  attachCopyCommandButtons();

  try {
    const release = await fetchLatestRelease();

    if (versionLabel && release.tag_name) {
      versionLabel.textContent = `Latest (${release.tag_name})`;
    }

    cards.forEach((card) => {
      const suffix = card.dataset.asset;
      if (!suffix) return;

      const match =
        suffix === "AppImage"
          ? (release.assets ?? []).find((asset) => asset.name.endsWith(".AppImage"))
          : (release.assets ?? []).find((asset) => asset.name.endsWith(`-${suffix}`));

      card.href = match?.browser_download_url ?? RELEASES_URL;
    });
  } catch {
    if (versionLabel) {
      versionLabel.textContent = "Could not load release info.";
    }

    cards.forEach((card) => {
      card.href = RELEASES_URL;
    });
  }
}
