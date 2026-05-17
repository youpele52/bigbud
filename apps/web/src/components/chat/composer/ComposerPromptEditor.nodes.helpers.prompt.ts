import {
  $getRoot,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $isElementNode,
  type ElementNode,
  type LexicalNode,
} from "lexical";
import type { ServerDiscoveredSkill } from "@bigbud/contracts";
import type { TerminalContextDraft } from "~/lib/terminalContext";
import { splitPromptIntoComposerSegments } from "../../../logic/composer";
import {
  ComposerTerminalContextNode,
  $createComposerMentionNode,
  $createComposerTerminalContextNode,
} from "./ComposerPromptEditor.nodes";

export function $appendTextWithLineBreaks(parent: ElementNode, text: string): void {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > 0) {
      parent.append($createTextNode(line));
    }
    if (index < lines.length - 1) {
      parent.append($createLineBreakNode());
    }
  }
}

export function $setComposerEditorPrompt(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft>,
  discoveredSkills: ReadonlyArray<ServerDiscoveredSkill> = [],
): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);
  const discoveredSkillsByName = new Map(discoveredSkills.map((skill) => [skill.name, skill]));
  const discoveredSkillsByDisplayName = new Map(
    discoveredSkills.flatMap((skill) =>
      skill.displayName ? [[skill.displayName, skill] as const] : [],
    ),
  );

  for (const segment of splitPromptIntoComposerSegments(prompt, terminalContexts)) {
    if (segment.type === "mention") {
      const resolvedSkill =
        segment.mentionKind === "skill"
          ? (discoveredSkillsByName.get(segment.displayLabel) ??
            discoveredSkillsByDisplayName.get(segment.displayLabel) ??
            discoveredSkillsByName.get(segment.rawValue.replace(/^skill::?/, "")))
          : undefined;
      paragraph.append(
        $createComposerMentionNode({
          rawValue: segment.rawValue,
          displayLabel: resolvedSkill?.displayName ?? resolvedSkill?.name ?? segment.displayLabel,
          mentionKind: segment.mentionKind,
        }),
      );
      continue;
    }
    if (segment.type === "terminal-context") {
      if (segment.context) {
        paragraph.append($createComposerTerminalContextNode(segment.context));
      }
      continue;
    }
    $appendTextWithLineBreaks(paragraph, segment.text);
  }
}

export function collectTerminalContextIds(node: LexicalNode): string[] {
  if (node instanceof ComposerTerminalContextNode) {
    return [node.__context.id];
  }
  if ($isElementNode(node)) {
    return node.getChildren().flatMap((child) => collectTerminalContextIds(child));
  }
  return [];
}

export function terminalContextSignature(contexts: ReadonlyArray<TerminalContextDraft>): string {
  return contexts
    .map((context) =>
      [
        context.id,
        context.threadId,
        context.terminalId,
        context.terminalLabel,
        context.lineStart,
        context.lineEnd,
        context.createdAt,
        context.text,
      ].join("\u001f"),
    )
    .join("\u001e");
}

export function clampExpandedCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(value.length, Math.floor(cursor)));
}
