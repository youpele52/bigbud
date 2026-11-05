import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AppCheckStatus } from "../../lib/checkStatus";

const remoteAccessState = {
  executionTargetChecks: {} as Record<string, { status: AppCheckStatus }>,
  verifiedExecutionTargetIds: {} as Record<string, true>,
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
    expect(resolveRemoteWorkspaceConnectionState({ checkStatus: "idle", isVerified: true })).toBe(
      "connected",
    );
  });

  it("reports connected for a verified check", () => {
    expect(
      resolveRemoteWorkspaceConnectionState({ checkStatus: "verified", isVerified: false }),
    ).toBe("connected");
  });

  it("reports connecting while remote access is being checked", () => {
    expect(
      resolveRemoteWorkspaceConnectionState({ checkStatus: "checking", isVerified: true }),
    ).toBe("connecting");
  });

  it.each([undefined, "idle", "auth_required", "error"] as const)(
    "reports disconnected for %s remote access",
    (checkStatus) => {
      expect(resolveRemoteWorkspaceConnectionState({ checkStatus, isVerified: false })).toBe(
        "disconnected",
      );
    },
  );
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
});
