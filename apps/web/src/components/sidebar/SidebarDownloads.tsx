import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { SidebarCopilotRuntime } from "./SidebarCopilotRuntime";

/** Identical download placement in chat and Settings; each job keeps independent state/actions. */
export function SidebarDownloads() {
  return (
    <>
      <SidebarUpdatePill />
      <SidebarCopilotRuntime />
    </>
  );
}
