import type { BrowserAnnotationSelection, BrowserAnnotationTheme } from "./BrowserPanel.annotation";

function mixPdfAnnotationColor(color: string, amount: number): string {
  return `color-mix(in srgb, ${color} ${amount}%, transparent)`;
}

function makePdfAnnotationNode(
  tag: string,
  options: { text?: string; style?: string } = {},
): HTMLElement {
  const node = document.createElement(tag);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.style) node.style.cssText = options.style;
  return node;
}

export function browserPdfAnnotationPickerScript(
  theme: BrowserAnnotationTheme,
): Promise<BrowserAnnotationSelection> {
  const STYLE = {
    root: "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:transparent;",
    mask: `position:fixed;inset:0;background:${mixPdfAnnotationColor(theme.infoForeground, 5)};pointer-events:none;`,
    box: `position:fixed;border:2px solid ${theme.infoForeground};background:${mixPdfAnnotationColor(theme.infoForeground, 16)};box-shadow:0 0 0 1px ${mixPdfAnnotationColor(theme.infoForeground, 32)};pointer-events:none;display:none;`,
    panel: `position:fixed;right:16px;bottom:16px;width:min(420px,calc(100vw - 32px));padding:14px;background:${theme.card};color:${theme.foreground};border:1px solid ${theme.border};border-radius:20px;box-shadow:0 18px 54px rgba(0,0,0,0.24);font:14px/1.4 ui-sans-serif,system-ui,sans-serif;pointer-events:auto;display:none;cursor:default;`,
    modeBar: "display:flex;gap:2px;margin-bottom:10px;",
    modeButton: `width:64px;height:28px;padding:0;border-radius:6px;border:0;background:transparent;color:${theme.mutedForeground};cursor:pointer;font-size:12px;font-weight:500;letter-spacing:0.01em;text-transform:capitalize;`,
    modeButtonActive: `width:64px;height:28px;padding:0;border-radius:6px;border:0;background:${mixPdfAnnotationColor(theme.foreground, 8)};color:${theme.foreground};cursor:pointer;font-size:12px;font-weight:600;letter-spacing:0.01em;text-transform:capitalize;`,
    title: `font-weight:500;margin-bottom:8px;color:${theme.foreground};letter-spacing:-0.01em;font-size:14px;`,
    target: `margin-bottom:10px;color:${theme.mutedForeground};word-break:break-word;font-size:12px;line-height:1.35;`,
    textarea: `width:100%;min-height:120px;resize:vertical;border-radius:16px;border:1px solid ${theme.border};background:${theme.card};color:${theme.foreground};padding:12px;box-sizing:border-box;outline:none;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:inset 0 0 0 1px ${mixPdfAnnotationColor(theme.ring, 0)};`,
    actions: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
    cancel: `padding:7px 12px;border-radius:10px;border:1px solid ${theme.border};background:${mixPdfAnnotationColor(theme.foreground, 4)};color:${theme.foreground};cursor:pointer;font-size:14px;`,
    submit: `padding:7px 12px;border-radius:10px;border:1px solid ${theme.primary};background:${theme.primary};color:${theme.primaryForeground};cursor:pointer;font-size:14px;`,
  } as const;

  return new Promise<BrowserAnnotationSelection>((resolve) => {
    document.getElementById("__bigbud_annotation_root")?.remove();

    const root = makePdfAnnotationNode("div", { style: STYLE.root });
    root.id = "__bigbud_annotation_root";
    const mask = makePdfAnnotationNode("div", { style: STYLE.mask });
    const box = makePdfAnnotationNode("div", { style: STYLE.box });
    const panel = makePdfAnnotationNode("div", { style: STYLE.panel });
    panel.id = "__bigbud_annotation_panel";
    const title = makePdfAnnotationNode("div", {
      text: "Annotate PDF region",
      style: STYLE.title,
    });
    const target = makePdfAnnotationNode("div", {
      text: "Drag to select the part of the PDF you want to capture.",
      style: STYLE.target,
    });
    const textarea = makePdfAnnotationNode("textarea", {
      style: STYLE.textarea,
    }) as HTMLTextAreaElement;
    const actions = makePdfAnnotationNode("div", { style: STYLE.actions });
    const cancel = makePdfAnnotationNode("button", {
      text: "Cancel",
      style: STYLE.cancel,
    }) as HTMLButtonElement;
    const submit = makePdfAnnotationNode("button", {
      text: "Add to chat",
      style: STYLE.submit,
    }) as HTMLButtonElement;
    cancel.type = "button";
    submit.type = "button";
    actions.append(cancel, submit);

    const modeBar = makePdfAnnotationNode("div", { style: STYLE.modeBar });
    const modeAsk = makePdfAnnotationNode("button", {
      text: "Ask",
      style: STYLE.modeButtonActive,
    }) as HTMLButtonElement;
    const modeContext = makePdfAnnotationNode("button", {
      text: "Context",
      style: STYLE.modeButton,
    }) as HTMLButtonElement;
    const modeFix = makePdfAnnotationNode("button", {
      text: "Fix",
      style: STYLE.modeButton,
    }) as HTMLButtonElement;
    modeAsk.type = "button";
    modeContext.type = "button";
    modeFix.type = "button";
    modeBar.append(modeAsk, modeContext, modeFix);

    panel.append(title, target, modeBar, textarea, actions);
    root.append(mask, box, panel);
    document.body.append(root);

    let intent: "ask" | "context" | "fix" = "ask";
    let dragging = false;
    let resolved = false;
    let startX = 0;
    let startY = 0;
    let rect = { x: 0, y: 0, width: 0, height: 0 };

    const updateModeButtons = () => {
      modeAsk.style.cssText = intent === "ask" ? STYLE.modeButtonActive : STYLE.modeButton;
      modeContext.style.cssText = intent === "context" ? STYLE.modeButtonActive : STYLE.modeButton;
      modeFix.style.cssText = intent === "fix" ? STYLE.modeButtonActive : STYLE.modeButton;
    };

    const updateTargetLabel = () => {
      target.textContent =
        rect.width > 0 && rect.height > 0
          ? `Selected region: x=${rect.x} y=${rect.y} width=${rect.width} height=${rect.height}`
          : "Drag to select the part of the PDF you want to capture.";
    };

    const cleanup = () => {
      resolved = true;
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("bigbud:browser-annotation-cancel", handleCancelEvent);
      root.remove();
    };

    const resolveCancelled = () => {
      if (resolved) return;
      cleanup();
      resolve({ cancelled: true });
    };

    const resolveSelection = () => {
      if (resolved) return;
      cleanup();
      resolve({
        cancelled: false,
        comment: textarea.value.trim(),
        intent,
        element: {
          selector: "",
          tag: "pdf-region",
          role: "region",
          text: "PDF region annotation",
          ariaLabel: null,
          id: null,
          className: "",
          rect,
        },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
      });
    };

    const updateRect = (clientX: number, clientY: number) => {
      const left = Math.min(startX, clientX);
      const top = Math.min(startY, clientY);
      const width = Math.abs(clientX - startX);
      const height = Math.abs(clientY - startY);
      rect = {
        x: Math.round(left),
        y: Math.round(top),
        width: Math.round(width),
        height: Math.round(height),
      };
      box.style.display = "block";
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${width}px`;
      box.style.height = `${height}px`;
      updateTargetLabel();
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (panel.contains(event.target as Node)) return;
      dragging = true;
      panel.style.display = "none";
      startX = event.clientX;
      startY = event.clientY;
      updateRect(event.clientX, event.clientY);
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      updateRect(event.clientX, event.clientY);
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      updateRect(event.clientX, event.clientY);
      if (rect.width < 6 || rect.height < 6) {
        box.style.display = "none";
        rect = { x: 0, y: 0, width: 0, height: 0 };
        updateTargetLabel();
        return;
      }
      panel.style.display = "block";
      textarea.focus();
      event.preventDefault();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        resolveCancelled();
      }
    };

    const handleCancelEvent = () => {
      resolveCancelled();
    };

    modeAsk.addEventListener("click", () => {
      intent = "ask";
      updateModeButtons();
    });
    modeContext.addEventListener("click", () => {
      intent = "context";
      updateModeButtons();
    });
    modeFix.addEventListener("click", () => {
      intent = "fix";
      updateModeButtons();
    });
    cancel.addEventListener("click", resolveCancelled);
    submit.addEventListener("click", resolveSelection);
    root.addEventListener("pointerdown", handlePointerDown);
    root.addEventListener("pointermove", handlePointerMove);
    root.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("bigbud:browser-annotation-cancel", handleCancelEvent);
    updateModeButtons();
  });
}
