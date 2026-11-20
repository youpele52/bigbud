import { SYSTEM_SEARCH_LOCAL_SOURCE_ID } from "@bigbud/contracts/search/systemSearch.ts";
import { describe, expect, it } from "vitest";

import { summarizeSearchNotices } from "./SearchPalette.notices.logic";
import type { SystemSearchNotice } from "./SearchPalette.systemSearch.logic";

const IDLE = "ssh:host=100.78.19.8&user=youpele&transport=agent";
const OLD = "ssh:host=46.225.127.53&user=root&transport=agent";
const SSH_ONLY = "ssh:host=134.94.117.230&user=techdbdevelop&transport=direct-ssh";
const SSH_ONLY_2 = "ssh:host=ice-2-kg&transport=direct-ssh";

function notice(
  sourceId: string,
  reason: SystemSearchNotice["reason"],
  tier: SystemSearchNotice["tier"] = "otherProjectFiles",
): SystemSearchNotice {
  return {
    tier,
    sourceId,
    reason,
    state: reason === "agent-update-available" ? "partial" : "unavailable",
  };
}

describe("summarizeSearchNotices", () => {
  it("shows nothing for remotes that are simply not connected", () => {
    expect(
      summarizeSearchNotices([notice(IDLE, "not-connected"), notice(OLD, "not-connected")]),
    ).toEqual({ failures: [], partial: null });
  });

  it("folds every other hint into one line with each source's reason as a detail", () => {
    const summary = summarizeSearchNotices([
      notice(IDLE, "not-connected"),
      notice(SSH_ONLY, "use-managed-agent"),
      notice(SSH_ONLY_2, "use-managed-agent"),
      notice(OLD, "agent-update-available"),
      // The same source and reason from another tier is one detail, not two.
      notice(OLD, "agent-update-available", "remoteOutsideProjects"),
    ]);
    expect(summary.failures).toEqual([]);
    expect(summary.partial).toEqual({
      text: "3 hosts not fully searched",
      details: [
        "Use the bigbud agent on techdbdevelop@134.94.117.230 for faster search across its projects.",
        "Use the bigbud agent on ice-2-kg for faster search across its projects.",
        "Showing file names only on root@46.225.127.53. Update its bigbud agent to search file contents.",
      ],
    });
  });

  it("words one source in the singular and counts this computer as a place", () => {
    expect(summarizeSearchNotices([notice(OLD, "busy")]).partial?.text).toBe(
      "1 host not fully searched",
    );
    expect(
      summarizeSearchNotices([
        notice(OLD, "busy"),
        notice(SYSTEM_SEARCH_LOCAL_SOURCE_ID, "agent-unavailable"),
      ]).partial?.text,
    ).toBe("2 places not fully searched");
  });

  it("keeps failures on connected hosts visible, once each", () => {
    const summary = summarizeSearchNotices([
      notice(OLD, "error"),
      notice(OLD, "error", "currentProject"),
      notice(SSH_ONLY, "use-managed-agent"),
    ]);
    expect(summary.failures).toEqual(["File search on root@46.225.127.53 failed."]);
    expect(summary.partial?.text).toBe("1 host not fully searched");
  });
});
