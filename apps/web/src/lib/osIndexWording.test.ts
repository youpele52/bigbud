import { describe, expect, it } from "vitest";

import { describeSearchNotice } from "../components/layout/SearchPalette.notices.logic";
import { describeThisComputerSearch } from "../components/settings/SearchSettingsSection";
import { osIndexSourceForPlatform, osIndexWording } from "./osIndexWording";

const notice = (sourceId: string, reason: "index-unavailable" | "disabled") =>
  describeSearchNotice({ tier: "thisComputer", sourceId, reason, state: "unavailable" }).text;

describe("OS index wording per source", () => {
  it("maps the desktop platform to its index", () => {
    expect(osIndexSourceForPlatform("MacIntel")).toBe("spotlight");
    expect(osIndexSourceForPlatform("Win32")).toBe("windows-search");
    expect(osIndexSourceForPlatform("Linux x86_64")).toBe("locate");
    expect(osIndexSourceForPlatform("FreeBSD amd64")).toBeNull();
  });

  it("names the place and the index, with the locate freshness caveat", () => {
    expect(osIndexWording("spotlight")).toMatchObject({ place: "this Mac", index: "Spotlight" });
    expect(osIndexWording("windows-search")).toMatchObject({
      place: "this PC",
      index: "Windows Search",
      staleNote: null,
    });
    expect(osIndexWording("locate").place).toBe("this computer");
    expect(osIndexWording("locate").staleNote).toContain("up to a day old");
    expect(osIndexWording("os-index").place).toBe("this computer");
  });

  it("words palette notices for the source that answered", () => {
    expect(notice("spotlight", "index-unavailable")).toBe(
      "The Spotlight index on this Mac is unavailable (Spotlight may be off or still indexing).",
    );
    expect(notice("windows-search", "index-unavailable")).toContain(
      "Windows Search index on this PC",
    );
    expect(notice("locate", "index-unavailable")).toContain("plocate or locate");
    expect(notice("windows-search", "disabled")).toBe(
      "Searching this PC is turned off in Settings.",
    );
  });

  it("words the Settings row per platform and File Access level", () => {
    expect(describeThisComputerSearch("spotlight", "common-folders")).toBe(
      "Uses Spotlight on this Mac, limited to Desktop, Documents, Downloads, Music and Pictures.",
    );
    expect(describeThisComputerSearch("windows-search", "unrestricted")).toBe(
      "Uses Windows Search on this PC, across your home folders.",
    );
    expect(describeThisComputerSearch("locate", "none")).toContain("up to a day old");
    expect(describeThisComputerSearch(null, "unrestricted")).toContain("Not available");
  });
});
