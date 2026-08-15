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
  resolveRemoteProjectConnectionState,
  SidebarRemoteProjectStatusIcon,
} from "./SidebarRemoteProjectStatusIcon";

describe("resolveRemoteProjectConnectionState", () => {
  it("reports connected for a verified remote target", () => {
    expect(resolveRemoteProjectConnectionState({ checkStatus: "idle", isVerified: true })).toBe(
      "connected",
    );
  });

  it("reports connected for a verified check", () => {
    expect(
      resolveRemoteProjectConnectionState({ checkStatus: "verified", isVerified: false }),
    ).toBe("connected");
  });

  it("reports connecting while remote access is being checked", () => {
    expect(resolveRemoteProjectConnectionState({ checkStatus: "checking", isVerified: true })).toBe(
      "connecting",
    );
  });

  it.each([undefined, "idle", "auth_required", "error"] as const)(
    "reports disconnected for %s remote access",
    (checkStatus) => {
      expect(resolveRemoteProjectConnectionState({ checkStatus, isVerified: false })).toBe(
        "disconnected",
      );
    },
  );
});

describe("SidebarRemoteProjectStatusIcon", () => {
  it("uses the execution target in its accessible label when no display label is available", () => {
    remoteAccessState.verifiedExecutionTargetIds["ssh:example.com"] = true;

    const html = renderToStaticMarkup(
      createElement(SidebarRemoteProjectStatusIcon, {
        executionTargetId: "ssh:example.com",
        remoteTargetLabel: null,
      }),
    );

    expect(html).toContain('aria-label="ssh:example.com: Connected"');
    expect(html).toContain('title="ssh:example.com: Connected"');
    expect(html.match(/text-emerald-500/g)).toHaveLength(2);
  });
});
