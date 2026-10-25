import { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { ToastProvider } from "../../ui/toast";
import { PersistentThreadTerminalDrawer } from "./ChatView.terminalDrawer";

const noop = () => undefined;

/** Real persistent drawers and emulators; only launch metadata and RPC are synthetic. */
export function TerminalDrawerSwitchFixture({
  active = "a",
  presentation = "fill",
}: {
  active?: string;
  presentation?: "split" | "fill" | "hidden";
}) {
  return (
    <ToastProvider>
      <div className="fixed inset-0 flex flex-col overflow-hidden">
        <div className="min-h-0 flex-1" data-chat-space />
        {["a", "b"].map((id) => (
          <PersistentThreadTerminalDrawer
            key={id}
            threadId={ThreadId.makeUnsafe(id)}
            visible={active === id}
            presentation={active === id ? presentation : "hidden"}
            launchContext={null}
            focusRequestId={0}
            splitShortcutLabel={undefined}
            newShortcutLabel={undefined}
            closeShortcutLabel={undefined}
            keybindings={[]}
            onAddTerminalContext={noop}
            onToggleExpanded={noop}
          />
        ))}
      </div>
    </ToastProvider>
  );
}
