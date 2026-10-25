import type {
  ServerDiscoveredAgent,
  ServerDiscoveredSkill,
} from "@bigbud/contracts/server/server.providers.ts";
import { splitPromptIntoComposerSegments } from "../../../logic/composer";
import { resolveMarkdownFileLinkTarget } from "../../../utils/markdown";
import { resolvePathLinkTarget } from "../../../utils/terminal/links.utils";
import { UserMessageMentionChip } from "./MessagesTimeline.userMessage.mentionChip";
import {
  normalizeMentionName,
  resolveMentionSourcePath,
  buildReferencedSourcePathLookup,
} from "./MessagesTimeline.userMessage.sources";

export function UserMessageMentionText(props: {
  text: string;
  cwd: string | undefined;
  references: ReturnType<typeof buildReferencedSourcePathLookup>;
  discoveredAgents: ReadonlyArray<ServerDiscoveredAgent>;
  discoveredSkills: ReadonlyArray<ServerDiscoveredSkill>;
  preferredProvider: string | undefined;
}) {
  const segments = splitPromptIntoComposerSegments(props.text, [], {
    allowTrailingAgentAndSkillMentions: true,
    allowTrailingPathMentions: true,
  });
  let textKeyIndex = 0;
  let mentionKeyIndex = 0;
  return segments.map((segment) => {
    if (segment.type === "text") {
      textKeyIndex += 1;
      return <span key={`user-message-text:${textKeyIndex}:${segment.text}`}>{segment.text}</span>;
    }
    if (segment.type !== "mention") return null;
    mentionKeyIndex += 1;
    const name = normalizeMentionName(segment.mentionKind, segment.rawValue, segment.displayLabel);
    const targetPath =
      segment.mentionKind === "path"
        ? props.cwd
          ? resolvePathLinkTarget(segment.rawValue, props.cwd)
          : resolveMarkdownFileLinkTarget(segment.rawValue)
        : segment.mentionKind === "plugin"
          ? null
          : resolveMentionSourcePath({
              kind: segment.mentionKind,
              name,
              references: props.references,
              agents: props.discoveredAgents,
              skills: props.discoveredSkills,
              preferredProvider: props.preferredProvider,
            });
    return (
      <UserMessageMentionChip
        key={`user-message-mention:${mentionKeyIndex}:${segment.rawValue}`}
        label={segment.displayLabel}
        rawValue={segment.rawValue}
        mentionKind={segment.mentionKind}
        targetPath={targetPath}
        workspaceRoot={props.cwd}
      />
    );
  });
}
