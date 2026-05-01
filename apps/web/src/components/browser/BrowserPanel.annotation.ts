export interface BrowserAnnotationElement {
  readonly selector: string;
  readonly tag: string;
  readonly role: string;
  readonly text: string;
  readonly ariaLabel: string | null;
  readonly id: string | null;
  readonly className: string;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface BrowserAnnotationViewport {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

export interface BrowserAnnotationResult {
  readonly comment: string;
  readonly page: {
    readonly url: string;
    readonly title: string;
  };
  readonly element: BrowserAnnotationElement;
  readonly viewport: BrowserAnnotationViewport;
  readonly screenshot: {
    readonly mime: "image/png";
    readonly dataUrl: string;
  };
}

export interface BrowserAnnotationTheme {
  readonly card: string;
  readonly foreground: string;
  readonly border: string;
  readonly input: string;
  readonly mutedForeground: string;
  readonly primary: string;
  readonly primaryForeground: string;
  readonly infoForeground: string;
  readonly ring: string;
}

export type BrowserAnnotationSelection =
  | { readonly cancelled: true }
  | {
      readonly cancelled: false;
      readonly comment: string;
      readonly element: BrowserAnnotationElement;
      readonly viewport: BrowserAnnotationViewport;
    };

export function buildBrowserAnnotationPrompt(annotation: BrowserAnnotationResult): string {
  const { element, page, viewport } = annotation;
  const rect = element.rect;
  const userInstruction = annotation.comment.trim() || "(no instruction provided)";

  return [
    "Browser annotation",
    "",
    "User instruction:",
    userInstruction,
    "",
    "Page:",
    `Title: ${page.title}`,
    `URL: ${page.url}`,
    `Viewport: width=${viewport.width} height=${viewport.height} devicePixelRatio=${viewport.devicePixelRatio}`,
    "",
    "Selected element:",
    `Selector: ${element.selector}`,
    `Tag: ${element.tag}`,
    `Role: ${element.role}`,
    `Text: ${element.text}`,
    `Aria label: ${element.ariaLabel ?? ""}`,
    `Rect: x=${rect.x} y=${rect.y} width=${rect.width} height=${rect.height}`,
    "",
    "Use the attached screenshot and selected element metadata to make the appropriate code change.",
  ].join("\n");
}

export function dataUrlToFile(dataUrl: string, name: string, mimeType: string): File | null {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return null;
  const header = dataUrl.slice(0, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  if (!header.includes(";base64") || payload.length === 0) return null;
  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], name, { type: mimeType });
  } catch {
    return null;
  }
}

export function browserAnnotationPickerScript(
  theme: BrowserAnnotationTheme,
): Promise<BrowserAnnotationSelection> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- this function is stringified for webview injection.
  const mix = (color: string, amount: number) =>
    `color-mix(in srgb, ${color} ${amount}%, transparent)`;
  const STYLE = {
    root: "position:fixed;inset:0;z-index:2147483647;pointer-events:none;",
    box: `position:fixed;border:2px solid ${theme.infoForeground};background:${mix(theme.infoForeground, 12)};box-shadow:0 0 0 1px ${mix(theme.infoForeground, 32)};pointer-events:none;`,
    panel: `position:fixed;right:16px;bottom:16px;width:min(420px,calc(100vw - 32px));padding:14px;background:${theme.card};color:${theme.foreground};border:1px solid ${theme.border};border-radius:20px;box-shadow:0 18px 54px rgba(0,0,0,0.24);font:14px/1.4 ui-sans-serif,system-ui,sans-serif;pointer-events:auto;display:none;`,
    title: `font-weight:500;margin-bottom:8px;color:${theme.foreground};letter-spacing:-0.01em;font-size:14px;`,
    target: `margin-bottom:10px;color:${theme.mutedForeground};word-break:break-word;font-size:12px;line-height:1.35;`,
    textarea: `width:100%;min-height:120px;resize:vertical;border-radius:16px;border:1px solid ${theme.border};background:${theme.card};color:${theme.foreground};padding:12px;box-sizing:border-box;outline:none;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;box-shadow:inset 0 0 0 1px ${mix(theme.ring, 0)};`,
    actions: "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;",
    cancel: `padding:7px 12px;border-radius:10px;border:1px solid ${theme.border};background:${mix(theme.foreground, 4)};color:${theme.foreground};cursor:pointer;font-size:14px;`,
    submit: `padding:7px 12px;border-radius:10px;border:1px solid ${theme.primary};background:${theme.primary};color:${theme.primaryForeground};cursor:pointer;font-size:14px;`,
  } as const;
  const ROLE_BY_TAG: Record<string, string> = {
    A: "link",
    BUTTON: "button",
    INPUT: "textbox",
    SELECT: "combobox",
    TEXTAREA: "textbox",
  };

  // eslint-disable-next-line unicorn/consistent-function-scoping -- this function is stringified for webview injection.
  const make = (tag: string, options: { text?: string; style?: string } = {}) => {
    const node = document.createElement(tag);
    if (options.text !== undefined) node.textContent = options.text;
    if (options.style) node.style.cssText = options.style;
    return node;
  };
  // eslint-disable-next-line unicorn/consistent-function-scoping -- this function is stringified for webview injection.
  const cssEscape = (value: string) =>
    window.CSS?.escape ? window.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  const buildSelector = (el: HTMLElement | null): string => {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return "";
    if (el.id) return `#${cssEscape(el.id)}`;
    const parts: string[] = [];
    let current: HTMLElement | null = el;
    while (current && parts.length < 5) {
      let part = current.tagName.toLowerCase();
      if (current.classList.length > 0) {
        part += `.${Array.from(current.classList).slice(0, 2).map(cssEscape).join(".")}`;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === current?.tagName,
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      if (current.parentElement?.id) {
        parts.unshift(`#${cssEscape(current.parentElement.id)}`);
        break;
      }
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const describeElement = (el: HTMLElement): BrowserAnnotationElement => {
    const rect = el.getBoundingClientRect();
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || ROLE_BY_TAG[el.tagName] || "",
      text: (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 500),
      ariaLabel: el.getAttribute("aria-label"),
      id: el.id || null,
      className: typeof el.className === "string" ? el.className : "",
      rect: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  };

  return new Promise((resolve) => {
    document.getElementById("__bigbud_annotation_root")?.remove();
    const root = make("div", { style: STYLE.root });
    root.id = "__bigbud_annotation_root";
    const box = make("div", { style: STYLE.box });
    const target = make("div", { style: STYLE.target });
    const textarea = make("textarea", { style: STYLE.textarea }) as HTMLTextAreaElement;
    textarea.placeholder = "What should the agent change here?";
    const cancel = make("button", { text: "Cancel", style: STYLE.cancel }) as HTMLButtonElement;
    const submit = make("button", {
      text: "Add to composer",
      style: STYLE.submit,
    }) as HTMLButtonElement;
    cancel.type = "button";
    submit.type = "button";
    const actions = make("div", { style: STYLE.actions });
    actions.append(cancel, submit);
    const panel = make("div", { style: STYLE.panel });
    panel.append(
      make("div", { text: "Annotate selection", style: STYLE.title }),
      target,
      textarea,
      actions,
    );
    root.append(box, panel);
    document.documentElement.appendChild(root);

    const state: { selected: HTMLElement | null; locked: boolean; finished: boolean } = {
      selected: null,
      locked: false,
      finished: false,
    };
    const updateHighlight = (el: HTMLElement | null) => {
      if (!el) {
        box.style.display = "none";
        return;
      }
      const rect = el.getBoundingClientRect();
      box.style.display = "block";
      box.style.top = `${rect.top}px`;
      box.style.left = `${rect.left}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    };
    const cleanup = () => {
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      root.remove();
    };
    const finish = (result: BrowserAnnotationSelection) => {
      if (state.finished) return;
      state.finished = true;
      cleanup();
      resolve(result);
    };
    const send = () => {
      if (!state.selected) {
        finish({ cancelled: true });
        return;
      }
      finish({
        cancelled: false,
        comment: textarea.value.trim(),
        element: describeElement(state.selected),
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        },
      });
    };
    function onMouseMove(event: MouseEvent) {
      if (state.locked) return;
      const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      if (!el || root.contains(el)) return;
      state.selected = el;
      updateHighlight(el);
    }
    function onClick(event: MouseEvent) {
      if (event.target instanceof Node && panel.contains(event.target)) return;
      if (state.locked) return;
      const el = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
      if (!el || root.contains(el)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      state.locked = true;
      state.selected = el;
      updateHighlight(el);
      target.textContent = `${el.tagName.toLowerCase()} ${buildSelector(el)}`.trim();
      panel.style.display = "block";
      textarea.focus();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish({ cancelled: true });
        return;
      }
      if (state.locked && event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        send();
      }
    }
    cancel.addEventListener("click", () => finish({ cancelled: true }));
    submit.addEventListener("click", send);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  });
}
