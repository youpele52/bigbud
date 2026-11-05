import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { TerminalSessionFixture } from "./TerminalViewport.session.fixture";
import { TerminalViewportErrorBoundary } from "./TerminalViewportErrorBoundary";

const mocks = vi.hoisted(() => ({ inputs: 0, disposed: 0 }));
vi.mock("../../rpc/nativeApi", () => ({ readNativeApi: () => ({ terminal: {} }) }));
vi.mock("./TerminalViewport.input", async (importOriginal) => {
  const original = await importOriginal<typeof import("./TerminalViewport.input")>();
  return {
    attachTerminalViewportInput: (
      ...args: Parameters<typeof original.attachTerminalViewportInput>
    ) => {
      const input = original.attachTerminalViewportInput(...args);
      mocks.inputs++;
      return {
        dispose: () => {
          mocks.disposed++;
          input.dispose();
        },
      };
    },
  };
});
vi.mock("./TerminalViewport.selection", () => ({
  attachTerminalSelection: () => {
    throw new Error("selection setup failed");
  },
}));
afterEach(() => {
  mocks.inputs = 0;
  mocks.disposed = 0;
});

it("disposes the input's global subscriptions when later selection setup fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const screen = await render(
    <TerminalViewportErrorBoundary terminalLabel="Fixture">
      <TerminalSessionFixture fontSize={12} onTerminal={() => undefined} />
    </TerminalViewportErrorBoundary>,
  );
  try {
    await expect
      .element(screen.getByText("This terminal view stopped unexpectedly."))
      .toBeVisible();
    expect(mocks.inputs).toBeGreaterThan(0);
    expect(mocks.disposed).toBe(mocks.inputs);
    await screen.getByRole("button", { name: "Reload terminal view" }).click();
    await expect.poll(() => mocks.inputs).toBeGreaterThan(1);
    expect(mocks.disposed).toBe(mocks.inputs);
  } finally {
    await screen.unmount();
  }
});
