import { beforeEach, describe, expect, it, vi } from "vitest";

import { notifyRemovedFileHistoryEntries } from "./FilesPanel.historyNotification";

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("../ui/toast", () => ({
  toastManager: {
    add: addToast,
  },
}));

describe("notifyRemovedFileHistoryEntries", () => {
  beforeEach(() => {
    addToast.mockReset();
  });

  it("reports removed history entries as a warning", () => {
    notifyRemovedFileHistoryEntries(1);

    expect(addToast).toHaveBeenCalledWith({
      type: "warning",
      title: "1 missing file removed from history.",
    });
  });

  it("does not notify when no history entries were removed", () => {
    notifyRemovedFileHistoryEntries(0);

    expect(addToast).not.toHaveBeenCalled();
  });
});
