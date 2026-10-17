import { expect, it } from "vitest";

import { toolWorkEntryHeading } from "../components/chat/messages/MessagesTimeline.workEntry.logic";
import { formatToolDisplayName } from "./toolPresentation";
import {
  browserActions,
  computerActions,
  ownedToolCatalogs,
  registeredToolNames,
} from "./toolPresentation.catalog.test.helpers";

for (const [provider, names] of Object.entries(ownedToolCatalogs)) {
  it.each(names)(
    `covers actual ${provider} registration %s with a descriptive lowercase label`,
    (name) => {
      const variants =
        provider === "native"
          ? [name]
          : provider === "coding"
            ? [`bigbud_${name}`]
            : provider === "remote"
              ? [`mcp__bigbud_remote_workspace__${name}`, `bigbud_remote_workspace_${name}`]
              : [
                  `bigbud_orchestration: ${name}`,
                  `mcp__bigbud_orchestration__${name}`,
                  `bigbud_orchestration_thread-1_${name}`,
                ];
      for (const variant of variants) {
        const label = formatToolDisplayName(variant);
        expect(label).toMatch(/^bigbud /);
        expect(label).toBe(label.toLowerCase());
        expect(label).not.toBe("bigbud tool");
        expect(formatToolDisplayName(variant.toUpperCase())).toBe(label);
      }
    },
  );
}

it("keeps remote generated MCP registrations aligned with their production names", () => {
  expect(
    registeredToolNames("remote-workspace-bridge/remoteWorkspaceMcpBridge.template.shared.ts"),
  ).toEqual(ownedToolCatalogs.remote.toSorted());
});

it.each(browserActions)("retains readable owned browser action %s", (toolAction) => {
  for (const toolTitle of [
    "bigbud_orchestration: browser",
    "mcp__bigbud_orchestration__browser",
    "bigbud_orchestration_thread-1_browser",
  ]) {
    const heading = toolWorkEntryHeading({
      id: "browser",
      createdAt: "2026-10-17T12:00:00Z",
      tone: "tool",
      label: "Tool",
      toolTitle,
      toolAction,
    });
    expect(heading).toMatch(/^bigbud · /);
    expect(heading).toBe(heading.toLowerCase());
    expect(heading).not.toBe("bigbud browser");
  }
});

it.each(computerActions)(
  "labels owned computer action %s without changing raw names",
  (toolAction) => {
    const toolTitle = "mcp__bigbud_orchestration__computer_use";
    const entry = Object.freeze({
      id: "computer",
      createdAt: "2026-10-17T12:00:00Z",
      tone: "tool" as const,
      label: "Tool",
      toolTitle,
      toolAction,
    });
    expect(toolWorkEntryHeading(entry)).toBe("bigbud computer controller");
    expect(entry.toolTitle).toBe(toolTitle);
    expect(entry.toolAction).toBe(toolAction);
  },
);
