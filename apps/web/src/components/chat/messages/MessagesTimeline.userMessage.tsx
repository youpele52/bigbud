import { DumbbellIcon } from "lucide-react";
import { memo, useMemo, type ReactNode } from "react";
import { TerminalContextInlineChip } from "../terminal/TerminalContextInlineChip";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "../common/userMessageTerminalContexts";
import { type ParsedTerminalContextEntry } from "~/lib/terminalContext";
import { splitPromptIntoComposerSegments } from "../../../logic/composer";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
} from "../view/composerInlineChip";
import { cn } from "~/lib/utils";
import { resolveMarkdownFileLinkTarget } from "../../../utils/markdown";
import { resolvePathLinkTarget } from "../../../utils/terminal/links.utils";
import {
  ChatFileTargetContextMenu,
  useChatFileTargetContextMenu,
} from "../common/ChatFileTargetContextMenu";
import { openChatFileTarget } from "../common/chatFileTargets";
import { VscodeEntryIcon } from "../common/VscodeEntryIcon";
import { useTheme } from "../../../hooks/useTheme";
import { inferEntryKindFromPath } from "../../../lib/vscode-icons";
import { useServerDiscoveredAgents, useServerDiscoveredSkills } from "../../../rpc/serverState";

const USER_MESSAGE_MENTION_BADGE_CLASS_NAME =
  "inline-flex shrink-0 rounded-sm border border-border/70 bg-background/60 px-1 py-0 text-[10px] font-semibold uppercase leading-none text-muted-foreground";

function resolveUserMessageMentionTarget(rawValue: string, cwd: string | undefined): string | null {
  if (cwd) {
    return resolvePathLinkTarget(rawValue, cwd);
  }
  return resolveMarkdownFileLinkTarget(rawValue, cwd);
}

function normalizeMentionName(
  mentionKind: "path" | "agent" | "skill",
  rawValue: string,
  displayLabel: string,
): string {
  if (mentionKind === "agent") {
    return rawValue.replace(/^agent::?/, "").trim() || displayLabel.trim();
  }
  if (mentionKind === "skill") {
    return rawValue.replace(/^skill::?/, "").trim() || displayLabel.trim();
  }
  return displayLabel.trim();
}

function addSourcePathToLookup(
  lookup: Map<string, Set<string>>,
  key: string,
  sourcePath: string,
): void {
  const existing = lookup.get(key);
  if (existing) {
    existing.add(sourcePath);
    return;
  }
  lookup.set(key, new Set([sourcePath]));
}

function resolveUniqueSourcePath(paths: ReadonlyArray<string | null | undefined>): string | null {
  const uniquePaths = [...new Set(paths.filter((value): value is string => !!value))];
  return uniquePaths.length === 1 ? uniquePaths[0]! : null;
}

function buildReferencedSourcePathLookup(messageText: string): {
  byName: Map<string, Set<string>>;
} {
  const byName = new Map<string, Set<string>>();
  const lines = messageText.split(/\r?\n/);
  let currentKind: "agent" | "skill" | null = null;
  let currentName: string | null = null;

  for (const line of lines) {
    const referencedAgentMatch = line.match(/^Referenced agent:\s*(.+)$/i);
    if (referencedAgentMatch?.[1]) {
      currentKind = "agent";
      currentName = referencedAgentMatch[1].trim().toLowerCase();
      continue;
    }
    const referencedSkillMatch = line.match(/^Referenced skill:\s*(.+)$/i);
    if (referencedSkillMatch?.[1]) {
      currentKind = "skill";
      currentName = referencedSkillMatch[1].trim().toLowerCase();
      continue;
    }
    const sourcePathMatch = line.match(/^Source path:\s*(.+)$/i);
    if (sourcePathMatch?.[1] && currentKind && currentName) {
      const sourcePath = sourcePathMatch[1].trim();
      addSourcePathToLookup(byName, `${currentKind}:${currentName}`, sourcePath);
    }
  }

  return { byName };
}

const UserMessageMentionChip = memo(function UserMessageMentionChip(props: {
  label: string;
  rawValue?: string;
  mentionKind: "path" | "agent" | "skill";
  targetPath?: string | null;
  workspaceRoot?: string | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const clickable = typeof props.targetPath === "string" && props.targetPath.length > 0;
  const inferredPathKind =
    props.mentionKind === "path"
      ? inferEntryKindFromPath(props.rawValue ?? props.label)
      : undefined;
  const { contextMenuState, hideContextMenu, showContextMenu } = useChatFileTargetContextMenu();
  return (
    <>
      <span
        className={cn(COMPOSER_INLINE_CHIP_CLASS_NAME, "mx-[1px]", clickable && "cursor-pointer")}
        title={
          clickable
            ? props.mentionKind === "path"
              ? "Double-click to open"
              : "Click to open"
            : undefined
        }
        onClick={
          clickable && props.mentionKind !== "path"
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                const targetPath = props.targetPath;
                if (!targetPath) return;
                openChatFileTarget(targetPath, props.workspaceRoot, "file");
              }
            : undefined
        }
        onDoubleClick={
          clickable && props.mentionKind === "path"
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                const targetPath = props.targetPath;
                if (!targetPath) return;
                openChatFileTarget(targetPath, props.workspaceRoot, inferredPathKind ?? "file");
              }
            : undefined
        }
        onContextMenu={
          clickable
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                const targetPath = props.targetPath;
                if (!targetPath) return;
                showContextMenu({
                  targetPath,
                  workspaceRoot: props.workspaceRoot,
                  kind: inferredPathKind ?? "file",
                  x: event.clientX,
                  y: event.clientY,
                });
              }
            : undefined
        }
      >
        {props.mentionKind === "path" ? (
          <VscodeEntryIcon
            pathValue={props.label}
            kind={inferredPathKind ?? "file"}
            theme={resolvedTheme}
            className="shrink-0 opacity-85"
          />
        ) : props.mentionKind === "skill" ? (
          <DumbbellIcon className="size-3.5 shrink-0 opacity-85" />
        ) : (
          <span className={USER_MESSAGE_MENTION_BADGE_CLASS_NAME}>{props.mentionKind}</span>
        )}
        <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{props.label}</span>
      </span>
      <ChatFileTargetContextMenu contextMenuState={contextMenuState} onClose={hideContextMenu} />
    </>
  );
});

function renderUserMessageTextWithMentionChips(input: {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly messageText: string;
  readonly discoveredAgents: ReadonlyArray<{ name: string; sourcePath?: string | undefined }>;
  readonly discoveredSkills: ReadonlyArray<{
    name: string;
    displayName?: string | undefined;
    sourcePath?: string | undefined;
  }>;
}): ReactNode {
  const referencedSourcePathLookup = buildReferencedSourcePathLookup(input.messageText);
  const segments = splitPromptIntoComposerSegments(input.text, [], {
    allowTrailingAgentAndSkillMentions: true,
    allowTrailingPathMentions: true,
  });
  if (segments.length === 0) {
    return input.text;
  }

  let textKeyIndex = 0;
  let mentionKeyIndex = 0;

  return segments.map((segment) => {
    if (segment.type === "text") {
      textKeyIndex += 1;
      return <span key={`user-message-text:${textKeyIndex}:${segment.text}`}>{segment.text}</span>;
    }
    if (segment.type === "mention") {
      mentionKeyIndex += 1;
      return (
        <UserMessageMentionChip
          key={`user-message-mention:${mentionKeyIndex}:${segment.rawValue}`}
          label={segment.displayLabel}
          rawValue={segment.rawValue}
          mentionKind={segment.mentionKind}
          targetPath={(() => {
            if (segment.mentionKind === "path") {
              return resolveUserMessageMentionTarget(segment.rawValue, input.cwd);
            }
            const mentionName = normalizeMentionName(
              segment.mentionKind,
              segment.rawValue,
              segment.displayLabel,
            );
            const lookupKey = `${segment.mentionKind}:${mentionName.toLowerCase()}`;
            const lookupMatch = resolveUniqueSourcePath([
              ...(referencedSourcePathLookup.byName.get(lookupKey) ?? new Set()).values(),
            ]);
            if (lookupMatch) {
              return lookupMatch;
            }
            if (segment.mentionKind === "agent") {
              const discoveredPaths = input.discoveredAgents
                .filter((agent) => agent.name.trim().toLowerCase() === mentionName.toLowerCase())
                .map((agent) => agent.sourcePath);
              return resolveUniqueSourcePath(discoveredPaths);
            }
            const discoveredPaths = input.discoveredSkills
              .filter(
                (skill) =>
                  skill.name.trim().toLowerCase() === mentionName.toLowerCase() ||
                  skill.displayName?.trim().toLowerCase() === mentionName.toLowerCase(),
              )
              .map((skill) => skill.sourcePath);
            return resolveUniqueSourcePath(discoveredPaths);
          })()}
          workspaceRoot={input.cwd}
        />
      );
    }
    return null;
  });
}

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

export const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  cwd: string | undefined;
}) {
  const discoveredAgents = useServerDiscoveredAgents();
  const discoveredSkills = useServerDiscoveredSkills();
  const discoveredAgentEntries = useMemo(
    () =>
      discoveredAgents.map((agent) => ({
        name: agent.name,
        sourcePath: agent.sourcePath,
      })),
    [discoveredAgents],
  );
  const discoveredSkillEntries = useMemo(
    () =>
      discoveredSkills.map((skill) => ({
        name: skill.name,
        displayName: skill.displayName,
        sourcePath: skill.sourcePath,
      })),
    [discoveredSkills],
  );

  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        <span key="user-message-terminal-context-inline-text">
          {renderUserMessageTextWithMentionChips({
            text: props.text,
            cwd: props.cwd,
            messageText: props.text,
            discoveredAgents: discoveredAgentEntries,
            discoveredSkills: discoveredSkillEntries,
          })}
        </span>,
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      {renderUserMessageTextWithMentionChips({
        text: props.text,
        cwd: props.cwd,
        messageText: props.text,
        discoveredAgents: discoveredAgentEntries,
        discoveredSkills: discoveredSkillEntries,
      })}
    </div>
  );
});
