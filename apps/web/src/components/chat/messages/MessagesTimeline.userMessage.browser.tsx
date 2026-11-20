import type { ChatAttachment } from "~/models/types";
import { IMAGE_ONLY_BOOTSTRAP_PROMPT } from "~/constants/chatPrompt";
import { applyClaudePromptEffortPrefix } from "@bigbud/shared/model";
import "../../../index.css";
import type {
  ServerDiscoveredAgent,
  ServerDiscoveredSkill,
} from "@bigbud/contracts/server/server.providers.ts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { UserMessageBody } from "./MessagesTimeline.userMessage";
import { MessagesTimeline } from "./MessagesTimeline";
import { MessageId } from "@bigbud/contracts/core/baseSchemas";

const mocks = vi.hoisted(() => ({
  agents: [] as ServerDiscoveredAgent[],
  skills: [] as ServerDiscoveredSkill[],
  openFile: vi.fn(),
}));
vi.mock("../../../rpc/serverState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../rpc/serverState")>()),
  useServerDiscoveredAgents: () => mocks.agents,
  useServerDiscoveredSkills: () => mocks.skills,
}));
vi.mock("../common/chatFileTargets", () => ({ openChatFileTarget: mocks.openFile }));

beforeEach(() => {
  mocks.agents = [];
  mocks.skills = [];
  mocks.openFile.mockClear();
});
afterEach(() => {
  document.body.innerHTML = "";
});

async function renderSentMessage(text: string, attachments: ChatAttachment[] = []) {
  return render(
    <MessagesTimeline
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      scrollContainer={null}
      timelineEntries={[
        {
          id: "entry",
          kind: "message",
          createdAt: "2026-10-20T12:00:00Z",
          message: {
            id: MessageId.makeUnsafe("message"),
            role: "user",
            text,
            attachments,
            createdAt: "2026-10-20T12:00:00Z",
            streaming: false,
          },
        },
      ]}
      completionDividerBeforeEntryId={null}
      completionSummary={null}
      turnDiffSummaryByAssistantMessageId={new Map()}
      nowIso="2026-10-20T12:00:00Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      activityAccordionOpenById={{}}
      onSetActivityAccordionOpen={() => {}}
      changedFilesExpandedByTurnId={{}}
      onSetChangedFilesExpanded={() => {}}
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd="/project"
      preferredProvider="opencode"
      resolvedTheme="light"
      timestampFormat="locale"
      workspaceRoot="/project"
    />,
  );
}

it.each(["agent", "skill"] as const)(
  "opens a sent %s chip on single click with duplicate provider names",
  async (kind) => {
    const entries = [
      {
        id: "codex",
        name: "review",
        provider: "codex",
        source: "user",
        sourcePath: "/codex/review.md",
      },
      {
        id: "opencode",
        name: "review",
        provider: "opencode",
        source: "user",
        sourcePath: "/opencode/review.md",
      },
    ] satisfies ServerDiscoveredAgent[];
    if (kind === "agent") mocks.agents = entries;
    else mocks.skills = entries;
    await renderSentMessage(`use @${kind}::review`);
    await page.getByText("review", { exact: true }).click();
    expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith(
      "/opencode/review.md",
      "/project",
      "file",
    );
  },
);

it("opens bundled skills ahead of the active provider's same-name skill", async () => {
  mocks.skills = [
    {
      id: "opencode",
      name: "review",
      provider: "opencode",
      source: "user",
      sourcePath: "/user/SKILL.md",
    },
    {
      id: "bundled",
      name: "review",
      provider: "bigbud",
      source: "system",
      sourcePath: "/bundled/SKILL.md",
    },
  ];
  await render(
    <UserMessageBody
      text="@skill::review"
      cwd="/project"
      terminalContexts={[]}
      preferredProvider="opencode"
    />,
  );
  await page.getByText("review", { exact: true }).click();
  expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith("/bundled/SKILL.md", "/project", "file");
});

it("uses raw message provenance when the displayed message omits metadata", async () => {
  mocks.agents = [
    { id: "new", name: "review", provider: "opencode", source: "user", sourcePath: "/new.md" },
  ];
  await render(
    <UserMessageBody
      text="@agent::review"
      cwd="/project"
      terminalContexts={[]}
      preferredProvider="opencode"
      sourceText={
        "@agent::review\nReferenced agent: review\nProvider: codex\nSource path: /recorded.md"
      }
    />,
  );
  await page.getByText("review", { exact: true }).click();
  expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith("/recorded.md", "/project", "file");
});

it("preserves clickable mentions alongside embedded terminal context labels", async () => {
  mocks.agents = [
    { id: "agent", name: "review", provider: "opencode", source: "user", sourcePath: "/review.md" },
  ];
  await render(
    <UserMessageBody
      text="@agent::review @terminal-1:1-5"
      cwd="/project"
      preferredProvider="opencode"
      terminalContexts={[{ header: "Terminal 1 lines 1-5", body: "output" }]}
    />,
  );
  await page.getByText("review", { exact: true }).click();
  expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith("/review.md", "/project", "file");
});

it("does not open an arbitrary provider source when no trustworthy match exists", async () => {
  mocks.agents = [
    { id: "codex", name: "review", provider: "codex", source: "user", sourcePath: "/codex.md" },
    {
      id: "claude",
      name: "review",
      provider: "claudeAgent",
      source: "user",
      sourcePath: "/claude.md",
    },
  ];
  await render(
    <UserMessageBody
      text="@agent::review"
      cwd="/project"
      terminalContexts={[]}
      preferredProvider="opencode"
    />,
  );
  await page.getByText("review", { exact: true }).click();
  expect(mocks.openFile).not.toHaveBeenCalled();
});

it.each(["@plugin::example", "@plugin:example"])(
  "keeps retired %s readable and inert",
  async (text) => {
    mocks.skills = [
      {
        id: "user-skill",
        name: "example",
        provider: "opencode",
        source: "user",
        sourcePath: "/skills/example/SKILL.md",
      },
    ];
    await render(
      <UserMessageBody
        text={text}
        cwd="/project"
        terminalContexts={[]}
        preferredProvider="opencode"
      />,
    );
    await expect.element(page.getByText("example", { exact: true })).toBeVisible();
    const chip = page.getByText("example", { exact: true });
    await chip.click();
    expect(chip.element().parentElement?.title).toContain("Retired plugin reference");
    expect(window.location.pathname).not.toContain("/plugins");
    expect(mocks.openFile).not.toHaveBeenCalled();
  },
);

it("opens the babysitter chip in Additional instructions using verified native OpenCode provenance", async () => {
  const sourcePath = "/home/user/.config/opencode/agents/babysitter.md";
  mocks.agents = [
    {
      id: "opencode:agent:babysitter",
      name: "babysitter",
      provider: "opencode",
      source: "user",
      sourcePath,
    },
    {
      id: "opencodeV2:native:babysitter",
      name: "babysitter",
      provider: "opencodeV2",
      source: "user",
      sourcePath,
    },
  ];
  await render(
    <UserMessageBody
      text={"Additional instructions:\n- @agent::babysitter h"}
      cwd="/project"
      terminalContexts={[]}
      preferredProvider="opencodeV2"
    />,
  );
  await page.getByText("babysitter", { exact: true }).click();
  expect(mocks.openFile).toHaveBeenCalledExactlyOnceWith(sourcePath, "/project", "file");
});

it.each([null, "ultrathink"])(
  "shows the screenshot without synthetic text (effort: %s)",
  async (effort) => {
    const prompt = applyClaudePromptEffortPrefix(IMAGE_ONLY_BOOTSTRAP_PROMPT, effort);
    await renderSentMessage(prompt, [
      {
        type: "image",
        id: "screenshot",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/X8AAAAASUVORK5CYII=",
      },
    ]);
    await expect.element(page.getByRole("img", { name: "screenshot.png" })).toBeVisible();
    expect(document.querySelector("[data-user-message-row]")?.textContent).not.toContain(
      IMAGE_ONLY_BOOTSTRAP_PROMPT,
    );
    expect(document.querySelector("[data-chat-cite-content]")).toBeNull();
  },
);
