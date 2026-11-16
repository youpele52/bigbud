import { SimpleWorkEntryRow } from "~/components/chat/messages/MessagesTimeline.workEntry";
import { workEntryDetailsFixture } from "../../../src/test-fixtures/MobileWorkEntryReference.data";

/** Actual desktop row; local disclosure only, no desktop execution/copy/SSH action surfaces. */
export function DesktopWorkEntryReference() {
  return (
    <main
      data-parity-client="desktop"
      data-parity-surface="work-entry-details"
      style={{ padding: 16, minWidth: 0 }}
    >
      <SimpleWorkEntryRow workEntry={workEntryDetailsFixture} showActions={false} />
    </main>
  );
}
