import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AppCheckStatus } from "../../lib/checkStatus";

const remoteAccessState = {
  executionTargetChecks: {} as Record<string, { status: AppCheckStatus }>,
  verifiedExecutionTargetIds: {} as Record<string, true>,
  disconnectedExecutionTargetIds: {} as Record<string, true>,
  disconnectedTargetsLoaded: true,
};

vi.mock("../../stores/remoteAccess/remoteAccess.store", () => ({
  useRemoteAccessStore: (selector: (state: typeof remoteAccessState) => unknown) =>
    selector(remoteAccessState),
}));

import {
  resolveRemoteWorkspaceConnectionState,
  SidebarRemoteWorkspaceStatusIcon,
} from "./SidebarRemoteWorkspaceStatusIcon";

describe("resolveRemoteWorkspaceConnectionState", () => {
  it("reports connected for a verified remote target", () => {
    expect(
      resolveRemoteWorkspaceConnectionState({
        checkStatus: "idle",
        isVerified: true,
        isUserDisconnected: false,
        disconnectedTargetsLoaded: true,
      }),
    ).toBe("connected");
  });

  it("reports connected for a verified check", () => {
    expect(
      resolveRemoteWorkspaceConnectionState({
        checkStatus: "verified",
        isVerified: false,
        isUserDisconnected: false,
        disconnectedTargetsLoaded: true,
      }),
    ).toBe("connected");
  });

  it("reports connecting while remote access is being checked", () => {
    expect(
      resolveRemoteWorkspaceConnectionState({
        checkStatus: "checking",
        isVerified: true,
        isUserDisconnected: false,
        disconnectedTargetsLoaded: true,
      }),
    ).toBe("connecting");
  });

  it.each([undefined, "idle", "checking", "verified", "auth_required", "error"] as const)(
    "reports paused for a user-disconnected target with %s remote access",
    (checkStatus) => {
      expect(
        resolveRemoteWorkspaceConnectionState({
          checkStatus,
          isVerified: true,
          isUserDisconnected: true,
          disconnectedTargetsLoaded: false,
        }),
      ).toBe("paused");
    },
  );

  it.each([undefined, "idle", "auth_required", "error"] as const)(
    "reports disconnected for %s remote access",
    (checkStatus) => {
      expect(
        resolveRemoteWorkspaceConnectionState({
          checkStatus,
          isVerified: false,
          isUserDisconnected: false,
          disconnectedTargetsLoaded: true,
        }),
      ).toBe("disconnected");
    },
  );
});

describe("resolveRemoteWorkspaceConnectionState before the disconnect list loads", () => {
  it.each([undefined, "idle", "error"] as const)(
    "shows connecting instead of red for %s remote access",
    (checkStatus) => {
      expect(
        resolveRemoteWorkspaceConnectionState({
          checkStatus,
          isVerified: false,
          isUserDisconnected: false,
          disconnectedTargetsLoaded: false,
        }),
      ).toBe("connecting");
    },
  );

  it("keeps a verified target connected", () => {
    expect(
      resolveRemoteWorkspaceConnectionState({
        checkStatus: "idle",
        isVerified: true,
        isUserDisconnected: false,
        disconnectedTargetsLoaded: false,
      }),
    ).toBe("connected");
  });
});

describe("SidebarRemoteWorkspaceStatusIcon", () => {
  it("uses the execution target in its accessible label when no display label is available", () => {
    remoteAccessState.verifiedExecutionTargetIds["ssh:example.com"] = true;

    const html = renderToStaticMarkup(
      createElement(SidebarRemoteWorkspaceStatusIcon, {
        executionTargetId: "ssh:example.com",
        remoteTargetLabel: null,
      }),
    );

    expect(html).toContain('aria-label="ssh:example.com: Connected"');
    expect(html).toContain('title="ssh:example.com: Connected"');
    expect(html.match(/text-emerald-500/g)).toHaveLength(2);
  });

  it("labels a failed connection Unavailable in red", () => {
    const html = renderToStaticMarkup(
      createElement(SidebarRemoteWorkspaceStatusIcon, {
        executionTargetId: "ssh:failed.example.com",
        remoteTargetLabel: "failed.example.com",
      }),
    );

    expect(html).toContain('aria-label="failed.example.com: Unavailable"');
    expect(html).toContain('data-connection-state="disconnected"');
    expect(html.match(/text-red-500/g)).toHaveLength(2);
  });

  it("labels a user-disconnected target Disconnected in neutral grey", () => {
    remoteAccessState.verifiedExecutionTargetIds["ssh:paused.example.com"] = true;
    remoteAccessState.disconnectedExecutionTargetIds["ssh:paused.example.com"] = true;

    const html = renderToStaticMarkup(
      createElement(SidebarRemoteWorkspaceStatusIcon, {
        executionTargetId: "ssh:paused.example.com",
        remoteTargetLabel: "paused.example.com",
      }),
    );

    expect(html).toContain('aria-label="paused.example.com: Disconnected"');
    expect(html).toContain('data-connection-state="paused"');
    expect(html).not.toContain("text-red-500");
    expect(html).not.toContain("text-emerald-500");
  });
});
