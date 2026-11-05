import { vi, type Mock } from "vitest";

const mocks: { read: Mock; write: Mock } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
export { mocks };
vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => ({
    projects: {
      readFilePreview: mocks.read,
      writeFile: mocks.write,
      onDirectoryChange: () => () => {},
    },
  }),
  ensureNativeApi: () => ({
    projects: {
      readFilePreview: mocks.read,
      writeFile: mocks.write,
      onDirectoryChange: () => () => {},
    },
  }),
}));
vi.mock("../../rpc/serverState", () => ({ useServerConfig: () => ({}) }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));

import { FilePreview } from "./FilePreview";
import { TooltipProvider } from "../ui/tooltip";

export const hash = "a".repeat(64);

/** Shared real preview harness for editing and recovery integration tests. */
export function preview(relativePath: string, executionTargetId?: string) {
  return (
    <TooltipProvider>
      <div style={{ width: 480, height: 280 }}>
        <FilePreview
          cwd="/workspace"
          relativePath={relativePath}
          executionTargetId={executionTargetId}
          canNavigateBack={false}
          canNavigateForward={false}
          onNavigateBack={() => {}}
          onNavigateForward={() => {}}
        />
      </div>
    </TooltipProvider>
  );
}
