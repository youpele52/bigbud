import { useState } from "react";
import { MobileAppHeader } from "../components/shell/MobileAppHeader";
import { MobileThreadView } from "../screens/MobileThread.view";
import { initialMobileRecoveryState } from "../logic/mobileRecovery.types";
import { initialMobileConnectionState } from "../logic/mobileConnection.logic";
import { MobileFixtureRouter } from "./MobileParityReference.chrome";
import { parityProviders } from "./MobileParityReference.data";
import {
  parityShellPrompt,
  parityShellThreadId,
  parityShellTime,
} from "./MobileParityReference.shell.data";

/** Actual mobile conversation/header/composer presentation with controlled fixture state. */
export function MobileParityShell() {
  const [value, setValue] = useState(parityShellPrompt);
  return (
    <MobileFixtureRouter threadId={parityShellThreadId}>
      <div className="flex h-dvh min-h-0 flex-col">
        <MobileAppHeader
          title="New chat"
          conversation
          onOpenNavigation={() => {}}
          onNew={() => {}}
        />
        <div className="min-h-0 flex-1">
          <MobileThreadView
            greetingContext={{
              identity: "parity-current-session-thread",
              name: "",
              settingsReady: true,
            }}
            activeWorkStartedAt={null}
            composerProps={{
              value,
              onChange: setValue,
              onSend: () => {},
              sessionScope: "thread-control",
              modelSelection: { provider: "codex", model: "gpt-5.4" },
              availableProviders: parityProviders,
              lockedProvider: "codex",
              onModelSelectionChange: () => {},
            }}
            messages={[]}
            messagesScrollRef={null}
            recoveryState={{ ...initialMobileRecoveryState("current"), actionsAvailable: true }}
            connection={{ ...initialMobileConnectionState(), transport: "open" }}
            onRetryRecovery={() => {}}
            isFollowing
            onScrollToLatest={() => {}}
            nowIso={parityShellTime}
            readerOutlineProps={{
              anchors: [],
              currentAnchorMessageId: null,
              onJumpToMessage: () => {},
            }}
            showWorkingIndicator={false}
            workingVerb="Working"
            workLogEntries={[]}
            workspaceRoot={undefined}
          />
        </div>
      </div>
    </MobileFixtureRouter>
  );
}
