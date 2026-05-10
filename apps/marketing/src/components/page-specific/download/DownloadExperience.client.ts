import { COPY_SUCCESS_TEXT } from "../../../constants/downloads";
import { fetchLatestRelease, RELEASES_URL } from "../../../lib/releases";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    textarea.style.inset = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const execCommand = (
      document as unknown as { execCommand: (commandId: string) => boolean }
    ).execCommand.bind(document);
    const didCopy = execCommand("copy");

    textarea.remove();
    return didCopy;
  }
}

export async function initDownloadExperience(): Promise<void> {
  const versionLabel = document.getElementById("version-label");
  const cards = document.querySelectorAll<HTMLAnchorElement>(".download-card");
  const installCommandBlocks =
    document.querySelectorAll<HTMLButtonElement>(".install-command-block");

  installCommandBlocks.forEach((block) => {
    block.addEventListener("click", async () => {
      const text = block.dataset.copyText;
      if (!text) return;

      const status = block.querySelector<HTMLElement>(".install-command-status");
      const copied = await copyText(text);

      if (status) {
        status.textContent = copied ? COPY_SUCCESS_TEXT : "";
        window.setTimeout(() => {
          status.textContent = "";
        }, 1600);
      }
    });
  });

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
