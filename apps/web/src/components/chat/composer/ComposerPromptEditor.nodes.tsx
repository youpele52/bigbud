import {
  $applyNodeReplacement,
  DecoratorNode,
  TextNode,
  type EditorConfig,
  type NodeKey,
  type SerializedLexicalNode,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import { type ReactElement } from "react";
import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import {
  basenameOfPath,
  getVscodeIconUrlForEntry,
  inferEntryKindFromPath,
} from "../../../lib/vscode-icons";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../view/composerInlineChip";
import { ComposerPendingTerminalContextChip } from "./ComposerPendingTerminalContexts";

// ---------------------------------------------------------------------------
// Serialized node shapes
// ---------------------------------------------------------------------------

export type SerializedComposerMentionNode = Spread<
  {
    rawValue: string;
    displayLabel: string;
    mentionKind: "path" | "agent" | "skill";
    type: "composer-mention";
    version: 1;
  },
  SerializedTextNode
>;

export type SerializedComposerTerminalContextNode = Spread<
  {
    context: TerminalContextDraft;
    type: "composer-terminal-context";
    version: 1;
  },
  SerializedLexicalNode
>;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function renderMentionChipDom(container: HTMLElement, pathValue: string): void {
  renderMentionChipDomWithLabel(container, pathValue, basenameOfPath(pathValue));
}

export function renderMentionChipDomWithLabel(
  container: HTMLElement,
  pathValue: string,
  labelValue: string,
  mentionKind: "path" | "agent" | "skill" = "path",
): void {
  container.textContent = "";
  container.style.setProperty("user-select", "none");
  container.style.setProperty("-webkit-user-select", "none");

  if (mentionKind === "path") {
    const theme = resolvedThemeFromDocument();
    const icon = document.createElement("img");
    icon.alt = "";
    icon.ariaHidden = "true";
    icon.className = COMPOSER_INLINE_CHIP_ICON_CLASS_NAME;
    icon.loading = "lazy";
    icon.src = getVscodeIconUrlForEntry(pathValue, inferEntryKindFromPath(pathValue), theme);
    container.append(icon);
  } else if (mentionKind === "skill") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", COMPOSER_INLINE_CHIP_ICON_CLASS_NAME);
    svg.innerHTML =
      '<path d="M17.596 12.768a2 2 0 1 0 2.829-2.829l-1.768-1.767a2 2 0 0 0 2.828-2.829l-2.828-2.828a2 2 0 0 0-2.829 2.828l-1.767-1.768a2 2 0 1 0-2.829 2.829z"/><path d="m2.5 21.5 1.4-1.4"/><path d="m20.1 3.9 1.4-1.4"/><path d="M5.343 21.485a2 2 0 1 0 2.829-2.828l1.767 1.768a2 2 0 1 0 2.829-2.829l-6.364-6.364a2 2 0 1 0-2.829 2.829l1.768 1.767a2 2 0 0 0-2.828 2.829z"/><path d="m9.6 14.4 4.8-4.8"/>';
    container.append(svg);
  } else {
    const badge = document.createElement("span");
    badge.className =
      "inline-flex shrink-0 rounded-sm border border-border/70 bg-background/60 px-1 py-0 text-[10px] font-semibold uppercase leading-none text-muted-foreground";
    badge.textContent = mentionKind;
    container.append(badge);
  }

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  label.textContent = labelValue;

  container.append(label);
}

// ---------------------------------------------------------------------------
// ComposerMentionNode
// ---------------------------------------------------------------------------

export class ComposerMentionNode extends TextNode {
  __rawValue: string;
  __displayLabel: string;
  __mentionKind: "path" | "agent" | "skill";

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(
      {
        rawValue: node.__rawValue,
        displayLabel: node.__displayLabel,
        mentionKind: node.__mentionKind,
      },
      node.__key,
    );
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode({
      rawValue: serializedNode.rawValue,
      displayLabel: serializedNode.displayLabel,
      mentionKind: serializedNode.mentionKind,
    });
  }

  constructor(
    input:
      | string
      | {
          rawValue: string;
          displayLabel?: string;
          mentionKind?: "path" | "agent" | "skill";
        },
    key?: NodeKey,
  ) {
    const rawValue = typeof input === "string" ? input : input.rawValue;
    const normalizedRawValue = rawValue.startsWith("@") ? rawValue.slice(1) : rawValue;
    const displayLabel = typeof input === "string" ? rawValue : (input.displayLabel ?? rawValue);
    const mentionKind = typeof input === "string" ? "path" : (input.mentionKind ?? "path");
    super(`@${normalizedRawValue}`, key);
    this.__rawValue = normalizedRawValue;
    this.__displayLabel = displayLabel;
    this.__mentionKind = mentionKind;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      rawValue: this.__rawValue,
      displayLabel: this.__displayLabel,
      mentionKind: this.__mentionKind,
      type: "composer-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderMentionChipDomWithLabel(dom, this.__rawValue, this.__displayLabel, this.__mentionKind);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerMentionNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (
      prevNode.__text !== this.__text ||
      prevNode.__rawValue !== this.__rawValue ||
      prevNode.__displayLabel !== this.__displayLabel ||
      prevNode.__mentionKind !== this.__mentionKind
    ) {
      renderMentionChipDomWithLabel(dom, this.__rawValue, this.__displayLabel, this.__mentionKind);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

export function $createComposerMentionNode(
  input:
    | string
    | {
        rawValue: string;
        displayLabel?: string;
        mentionKind?: "path" | "agent" | "skill";
      },
): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(input));
}

// ---------------------------------------------------------------------------
// ComposerTerminalContextNode
// ---------------------------------------------------------------------------

function ComposerTerminalContextDecorator(props: { context: TerminalContextDraft }) {
  return <ComposerPendingTerminalContextChip context={props.context} />;
}

export class ComposerTerminalContextNode extends DecoratorNode<ReactElement> {
  __context: TerminalContextDraft;

  static override getType(): string {
    return "composer-terminal-context";
  }

  static override clone(node: ComposerTerminalContextNode): ComposerTerminalContextNode {
    return new ComposerTerminalContextNode(node.__context, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerTerminalContextNode,
  ): ComposerTerminalContextNode {
    return $createComposerTerminalContextNode(serializedNode.context);
  }

  constructor(context: TerminalContextDraft, key?: NodeKey) {
    super(key);
    this.__context = context;
  }

  override exportJSON(): SerializedComposerTerminalContextNode {
    return {
      ...super.exportJSON(),
      context: this.__context,
      type: "composer-terminal-context",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "inline-flex align-middle leading-none";
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return <ComposerTerminalContextDecorator context={this.__context} />;
  }
}

export function $createComposerTerminalContextNode(
  context: TerminalContextDraft,
): ComposerTerminalContextNode {
  return $applyNodeReplacement(new ComposerTerminalContextNode(context));
}

// ---------------------------------------------------------------------------
// Shared inline token type helpers
// ---------------------------------------------------------------------------

export type ComposerInlineTokenNode = ComposerMentionNode | ComposerTerminalContextNode;

export function isComposerInlineTokenNode(
  candidate: unknown,
): candidate is ComposerInlineTokenNode {
  return (
    candidate instanceof ComposerMentionNode || candidate instanceof ComposerTerminalContextNode
  );
}
