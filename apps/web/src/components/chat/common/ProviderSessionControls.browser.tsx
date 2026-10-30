import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type {
  ProviderControlsInput,
  ProviderControlsSnapshot,
} from "@bigbud/contracts/server/providerControls";
import { useProviderSessionControls } from "./useProviderSessionControls";
import { ContextWindowRecoveryActions } from "./ContextWindowRecoveryActions";
import { ProviderMcpControls } from "./ProviderMcpControls";
import { COMPACT_LABELS } from "./ProviderSessionControls.logic";

const { providerControls } = vi.hoisted(() => ({ providerControls: vi.fn() }));
vi.mock("~/rpc/nativeApi", () => ({ readNativeApi: () => ({ server: { providerControls } }) }));

function snapshot(
  input: ProviderControlsInput,
  state: ProviderControlsSnapshot["compactState"] = "idle",
): ProviderControlsSnapshot {
  return {
    threadId: input.threadId,
    sessionEpoch: input.sessionEpoch,
    compactState: state,
    compact: { available: state === "idle", reason: state === "idle" ? "" : "Native work pending" },
    mcpStatus: { available: true, reason: "" },
    mcpReload: { available: true, reason: "" },
    mcpTargeted: { available: false, reason: "Targeted reconnect unavailable" },
  };
}

function ControlsHarness() {
  const [threadId, setThreadId] = useState(ThreadId.makeUnsafe("a"));
  const [epoch, setEpoch] = useState(2);
  const {
    snapshot: value,
    request,
    pending,
    error,
  } = useProviderSessionControls(threadId, epoch, true);
  return (
    <div>
      <button onClick={() => setThreadId((id) => ThreadId.makeUnsafe(id === "a" ? "b" : "a"))}>
        Change thread
      </button>
      <button onClick={() => setEpoch((epoch) => (epoch === 2 ? 3 : 2))}>Change epoch</button>
      <button disabled={pending} onClick={() => void request("status")}>
        Read status
      </button>
      <ContextWindowRecoveryActions
        handoffAvailable={false}
        onUseHandoff={() => {}}
        onCompact={() => void request("compact")}
        compactAvailable={!!value?.compact.available && !pending}
        compactReason={value?.compact.reason ?? "Requires current availability"}
      />
      <ProviderMcpControls
        snapshot={value}
        pending={pending}
        onRefresh={() => void request("refresh-mcp")}
        onReload={() => void request("reload-mcp")}
      />
      <p data-testid="state">
        {value ? COMPACT_LABELS[value.compactState] : "Loading availability"}
      </p>
      {error && <p role="alert">{error}</p>}
      {value?.message && <p>{value.message}</p>}
    </div>
  );
}

beforeEach(() => {
  providerControls.mockReset();
  providerControls.mockImplementation(async (input: ProviderControlsInput) => snapshot(input));
});
afterEach(() => vi.restoreAllMocks());

describe("epoch-fenced native controls UI", () => {
  it.each(["Change thread", "Change epoch"])(
    "rejects ABA responses after %s twice",
    async (change) => {
      await render(<ControlsHarness />);
      await expect.element(page.getByRole("button", { name: "Compact context" })).toBeEnabled();
      let resolve!: (value: ProviderControlsSnapshot) => void;
      let submitted!: ProviderControlsInput;
      providerControls.mockImplementation((input: ProviderControlsInput) => {
        if (input.action === "compact") {
          submitted = input;
          return new Promise((done) => {
            resolve = done;
          });
        }
        return Promise.resolve(snapshot(input));
      });
      await page.getByRole("button", { name: "Compact context" }).click();
      await page.getByRole("button", { name: change }).click();
      await expect.element(page.getByTestId("state")).toHaveTextContent(COMPACT_LABELS.idle);
      await page.getByRole("button", { name: change }).click();
      await expect.element(page.getByTestId("state")).toHaveTextContent(COMPACT_LABELS.idle);
      resolve(snapshot(submitted, "completed"));
      await expect
        .element(page.getByTestId("state"))
        .not.toHaveTextContent(COMPACT_LABELS.completed);
    },
  );
  it("shows ack as submitted, then working, completed and unknown only from status", async () => {
    await render(<ControlsHarness />);
    await expect.element(page.getByRole("button", { name: "Compact context" })).toBeEnabled();
    providerControls.mockImplementation(async (input: ProviderControlsInput) =>
      snapshot(input, "submitted"),
    );
    await page.getByRole("button", { name: "Compact context" }).click();
    await expect.element(page.getByTestId("state")).toHaveTextContent(COMPACT_LABELS.submitted);
    await expect.element(page.getByRole("button", { name: "Compact context" })).toBeDisabled();
    for (const state of ["working", "completed", "unknown", "failed"] as const) {
      providerControls.mockImplementation(async (input: ProviderControlsInput) =>
        snapshot(input, state),
      );
      await page.getByRole("button", { name: "Read status" }).click();
      await expect.element(page.getByTestId("state")).toHaveTextContent(COMPACT_LABELS[state]);
    }
    expect(
      providerControls.mock.calls.filter(([input]) => input.action === "compact"),
    ).toHaveLength(1);
  });
  it.each(["Change thread", "Change epoch"])("ignores late results after %s", async (change) => {
    await render(<ControlsHarness />);
    await expect.element(page.getByRole("button", { name: "Compact context" })).toBeEnabled();
    let resolve!: (value: ProviderControlsSnapshot) => void;
    let submitted!: ProviderControlsInput;
    providerControls.mockImplementation((input: ProviderControlsInput) => {
      if (input.action === "compact") {
        submitted = input;
        return new Promise((done) => {
          resolve = done;
        });
      }
      return Promise.resolve(snapshot(input));
    });
    await page.getByRole("button", { name: "Compact context" }).click();
    await page.getByRole("button", { name: change }).click();
    await expect.element(page.getByTestId("state")).toHaveTextContent(COMPACT_LABELS.idle);
    resolve(snapshot(submitted, "completed"));
    await expect.element(page.getByTestId("state")).not.toHaveTextContent(COMPACT_LABELS.completed);
  });
  it("keeps reload-all failure visible after status refresh and prevents duplicate submission", async () => {
    await render(<ControlsHarness />);
    await expect
      .element(page.getByRole("button", { name: "Reload all MCP servers" }))
      .toBeEnabled();
    let finish!: () => void;
    providerControls.mockImplementation((input: ProviderControlsInput) =>
      input.action === "reload-mcp"
        ? new Promise((resolve) => {
            finish = () =>
              resolve({
                ...snapshot(input),
                reloadState: "unknown",
                message: "Reload may have partially applied",
              });
          })
        : Promise.resolve(snapshot(input)),
    );
    await page.getByRole("button", { name: "Reload all MCP servers" }).click();
    await expect
      .element(page.getByRole("button", { name: "Reload all MCP servers" }))
      .toBeDisabled();
    finish();
    await expect.element(page.getByText("Reload may have partially applied")).toBeVisible();
    await page.getByRole("button", { name: "Read status" }).click();
    await expect.element(page.getByText("Reload may have partially applied")).toBeVisible();
    expect(
      providerControls.mock.calls.filter(([input]) => input.action === "reload-mcp"),
    ).toHaveLength(1);
  });
  it("reports a disconnected mutation without replaying it", async () => {
    await render(<ControlsHarness />);
    await expect.element(page.getByRole("button", { name: "Compact context" })).toBeEnabled();
    providerControls.mockRejectedValue(new Error("Disconnected; outcome unknown"));
    await page.getByRole("button", { name: "Compact context" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("outcome unknown");
    expect(
      providerControls.mock.calls.filter(([input]) => input.action === "compact"),
    ).toHaveLength(1);
  });
});
