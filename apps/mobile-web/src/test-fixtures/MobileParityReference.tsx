import type { ProviderKind } from "@bigbud/contracts";
import { useState } from "react";
import { BigbudLoader } from "~/components/layout/BigbudLoader";
import { ComposerPromptEditor } from "~/components/chat/composer/ComposerPromptEditor";
import { FloatingPendingApprovalCard } from "~/components/floating-assistant/FloatingPendingApprovalCard";
import { CompactActivityGroup } from "~/components/chat/common/CompactActivityGroup";
import { ProviderModelPicker } from "~/components/chat/provider/ProviderModelPicker";
import type { ModelOption } from "~/components/chat/provider/ProviderModelPicker.models";
import ChatMarkdown from "~/components/chat/common/ChatMarkdown";
import { ChatGreeting } from "~/components/chat/common/ChatGreeting";
import { MobileStartupSplash } from "../components/shell/MobileStartupSplash";
import { MobileComposer } from "../components/threads/thread/composer/MobileComposer";
import { MobileComposerModelPicker } from "../components/threads/thread/composer/MobileComposerModelPicker";
import { MobileMessages } from "../components/threads/thread/MobileMessages";
import { MobileWorkLog } from "../components/threads/thread/MobileWorkLog";
import { MobileWorkLogEntry } from "../components/threads/thread/MobileWorkLogEntry";
import { workEntryDetailsFixture } from "./MobileWorkEntryReference.data";
import { MobileParityChrome } from "./MobileParityReference.chrome";
import { MobileParityThreads } from "./MobileParityReference.threads";
import { MobileParityShell } from "./MobileParityReference.shell";
import { MobileParityQuestion } from "./MobileParityReference.question";
import { MobileParityProviders } from "./MobileParityReference.providers";
import {
  parityApproval,
  parityProviders,
  parityWorkLog,
  parityMarkdown,
  parityMessage,
} from "./MobileParityReference.data";

const noop = () => {};
const modelOptions: Record<ProviderKind, ReadonlyArray<ModelOption>> = {
  codex: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
  claudeAgent: [],
  cliProxy: [],
  copilot: [],
  cursor: [],
  devin: [],
  muse: [],
  opencode: [],
  opencodeV2: [],
  pi: [],
};

/** Actual current presentation components, isolated from app/runtime/real account state. */
export function MobileParityReference({
  client,
  surface,
}: {
  client: "desktop" | "mobile";
  surface: string;
}) {
  const [value, setValue] = useState("What are we working on?");
  const desktop = client === "desktop";
  let content;
  switch (surface) {
    case "shell":
      content = <MobileParityShell />;
      break;
    case "header":
    case "error":
      content = <MobileParityChrome client={client} surface={surface} />;
      break;
    case "thread-list":
      content = <MobileParityThreads client={client} />;
      break;
    case "empty":
      content = desktop ? (
        <ChatGreeting />
      ) : (
        <MobileMessages messages={[]} cwd={undefined} showEmptyState />
      );
      break;
    case "loading":
      content = desktop ? <BigbudLoader /> : <MobileStartupSplash className="h-full min-h-0" />;
      break;
    case "editor":
      content = desktop ? (
        <ComposerPromptEditor
          value={value}
          cursor={value.length}
          terminalContexts={[]}
          disabled={false}
          placeholder="What are we working on?"
          compact
          onRemoveTerminalContext={noop}
          onChange={setValue}
          onPaste={noop}
        />
      ) : (
        <MobileComposer value={value} onChange={setValue} onSend={noop} />
      );
      break;
    case "approval":
      content = desktop ? (
        <FloatingPendingApprovalCard
          approval={parityApproval}
          isResponding={false}
          onRespondToApproval={async () => {}}
        />
      ) : (
        <MobileComposer
          value=""
          onChange={noop}
          onSend={noop}
          pendingApproval={parityApproval}
          onRespondToApproval={noop}
        />
      );
      break;
    case "question":
      content = <MobileParityQuestion client={client} />;
      break;
    case "markdown":
      content = desktop ? (
        <ChatMarkdown cwd={undefined} text={parityMarkdown} />
      ) : (
        <MobileMessages cwd={undefined} messages={[parityMessage]} />
      );
      break;
    case "work-entry-details":
      content = <MobileWorkLogEntry entry={workEntryDetailsFixture} />;
      break;
    case "work-log":
      content = desktop ? (
        <CompactActivityGroup label="Work log" count={1}>
          <p className="text-xs">{parityApproval.detail}</p>
        </CompactActivityGroup>
      ) : (
        <MobileWorkLog entries={parityWorkLog} />
      );
      break;
    case "provider-picker":
      content = <MobileParityProviders client={client} />;
      break;
    case "model-picker":
      content = desktop ? (
        <ProviderModelPicker
          compact
          provider="codex"
          model="gpt-5.4"
          lockedProvider="codex"
          providers={parityProviders}
          modelOptionsByProvider={modelOptions}
          onProviderModelChange={noop}
        />
      ) : (
        <MobileComposerModelPicker
          selection={{ provider: "codex", model: "gpt-5.4" }}
          lockedProvider="codex"
          providers={parityProviders}
          onChange={noop}
        />
      );
      break;
    default:
      throw new Error("Unknown parity fixture surface");
  }
  const Frame = surface === "shell" ? "div" : "main";
  return (
    <Frame
      data-parity-client={client}
      data-parity-surface={surface}
      style={{
        minWidth: 0,
        height: ["loading", "empty", "shell"].includes(surface) ? "100dvh" : undefined,
        padding: ["loading", "empty", "shell"].includes(surface) ? 0 : 16,
      }}
    >
      {content}
    </Frame>
  );
}
