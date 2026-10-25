import { memo, useMemo, type ReactNode } from "react";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "../common/userMessageTerminalContexts";
import { type ParsedTerminalContextEntry } from "~/lib/terminalContext";
import { useServerDiscoveredAgents, useServerDiscoveredSkills } from "../../../rpc/serverState";
import { UserMessageMentionText } from "./MessagesTimeline.userMessage.mentions";
import { buildReferencedSourcePathLookup } from "./MessagesTimeline.userMessage.sources";
import { UserMessageTerminalContextInlineLabel } from "./MessagesTimeline.userMessage.terminalLabel";

export const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  sourceText?: string;
  terminalContexts: ParsedTerminalContextEntry[];
  cwd: string | undefined;
  preferredProvider?: string | undefined;
}) {
  const discoveredAgents = useServerDiscoveredAgents();
  const discoveredSkills = useServerDiscoveredSkills();
  const references = useMemo(
    () => buildReferencedSourcePathLookup(props.sourceText ?? props.text),
    [props.sourceText, props.text],
  );
  const mentionProps = {
    cwd: props.cwd,
    references,
    discoveredAgents,
    discoveredSkills,
    preferredProvider: props.preferredProvider,
  };

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
            <UserMessageMentionText
              key={`before:${cursor}`}
              text={props.text.slice(cursor, matchIndex)}
              {...mentionProps}
            />,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`context:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }
      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <UserMessageMentionText
              key={`rest:${cursor}`}
              text={props.text.slice(cursor)}
              {...mentionProps}
            />,
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
          key={`context:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }
    if (props.text.length > 0) {
      inlineNodes.push(<UserMessageMentionText key="text" text={props.text} {...mentionProps} />);
    } else if (inlinePrefix.length === 0) return null;
    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) return null;
  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      <UserMessageMentionText text={props.text} {...mentionProps} />
    </div>
  );
});
