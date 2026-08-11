import type { ServerProvider } from "@bigbud/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

interface TestToast {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly actionProps?: { readonly onClick?: () => void };
}

const mocks = vi.hoisted(() => ({
  providers: [] as Array<unknown>,
  navigate: vi.fn(),
  add: vi.fn((_toast: TestToast) => "provider-recovery-toast"),
  update: vi.fn((_id: string, _toast: TestToast) => undefined),
}));

vi.mock("../rpc/serverState", () => ({
  useServerProviders: () => mocks.providers,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: mocks.add, update: mocks.update },
}));

import { ProviderRecoveryToastCoordinator } from "./ProviderRecoveryToastCoordinator";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    provider: "opencode",
    enabled: true,
    installed: true,
    version: "1.17.18",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-11T12:00:00.000Z",
    initialProbeComplete: true,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const recovery = {
  operationId: "startup-operation",
  generation: 1,
  attempt: 1,
  maxAttempts: 5,
  trigger: "startup",
  status: "retrying",
} as const;

describe("ProviderRecoveryToastCoordinator", () => {
  afterEach(() => {
    mocks.providers = [];
    mocks.navigate.mockReset();
    mocks.add.mockClear();
    mocks.update.mockReset();
    document.body.innerHTML = "";
  });

  it("groups launch recovery, updates on reconnect, navigates, and then reports success", async () => {
    const failing = [
      provider({
        provider: "opencode",
        status: "error",
        failure: { classification: "retryable", reason: "startup-timeout" },
        recovery,
      }),
      provider({
        provider: "kilocode",
        status: "error",
        failure: { classification: "retryable", reason: "process-failed" },
        recovery,
      }),
      provider({ provider: "codex", initialProbeComplete: false }),
    ];
    mocks.providers = failing;
    const screen = await render(<ProviderRecoveryToastCoordinator />);

    await vi.waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1));
    const warning = mocks.add.mock.calls[0]![0];
    expect(warning.title).toBe("Starting providers");
    expect(warning.description).toContain("OpenCode, KiloCode");

    mocks.providers = [...failing];
    await screen.rerender(<ProviderRecoveryToastCoordinator />);
    await vi.waitFor(() => expect(mocks.update).toHaveBeenCalled());
    expect(mocks.add).toHaveBeenCalledTimes(1);

    warning.actionProps?.onClick?.();
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { providers: ["opencode", "kilocode"] },
    });

    mocks.providers = failing.slice(0, 2).map((snapshot) =>
      provider({
        provider: snapshot.provider,
        recovery: { ...recovery, attempt: 2, status: "recovered" },
      }),
    );
    await screen.rerender(<ProviderRecoveryToastCoordinator />);

    await vi.waitFor(() => {
      const update = mocks.update.mock.calls.at(-1)?.[1];
      expect(update?.type).toBe("success");
      expect(update?.title).toBe("Providers are ready");
    });
    expect(mocks.add).toHaveBeenCalledTimes(1);
  });

  it("does not show a recovery success when no warning was displayed", async () => {
    mocks.providers = [provider({ recovery: { ...recovery, status: "recovered" } })];
    await render(<ProviderRecoveryToastCoordinator />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.add).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
