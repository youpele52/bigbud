import { expect, it, vi } from "vitest";
import { announceMascotAttention } from "../floating-assistant/mascotAttention.logic";
import { anchoredToastManager, toastManager } from "./toast.manager";

vi.mock("../floating-assistant/mascotAttention.logic", () => ({
  announceMascotAttention: vi.fn(),
}));

it("keeps both manager APIs on one stack without duplicating mascot attention", () => {
  expect(anchoredToastManager).toBe(toastManager);
  const normal = toastManager.add({ title: "Normal", type: "info" });
  const legacy = anchoredToastManager.add({ title: "Legacy", type: "warning" });
  expect(normal).not.toBe(legacy);
  expect(announceMascotAttention).toHaveBeenCalledTimes(2);
  toastManager.update(normal, { type: "success" });
  anchoredToastManager.close(legacy);
  expect(announceMascotAttention).toHaveBeenCalledTimes(2);
});
