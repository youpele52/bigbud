import { COPY_SUCCESS_TEXT } from "../constants/downloads";

export async function copyText(text: string): Promise<boolean> {
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

export function attachCopyCommandButtons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>("[data-copy-text]").forEach((button) => {
    if (button.dataset.copyBound === "true") return;

    button.dataset.copyBound = "true";
    button.addEventListener("click", async () => {
      const text = button.dataset.copyText;
      if (!text) return;

      const status = button.querySelector<HTMLElement>("[data-copy-status]");
      const copied = await copyText(text);

      if (status) {
        status.textContent = copied ? COPY_SUCCESS_TEXT : "";
        window.setTimeout(() => {
          status.textContent = "";
        }, 1600);
      }
    });
  });
}
