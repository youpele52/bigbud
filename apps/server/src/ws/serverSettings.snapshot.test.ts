import { expect, it, vi } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts";
import { ServerSettingsSnapshot } from "./serverSettings.snapshot.ts";

it("accepts the authoritative snapshot before listeners and continues invalidation after listener failure", () => {
  const state = new ServerSettingsSnapshot();
  expect(state.read()).toBeUndefined();
  state.subscribe(() => {
    throw new Error("observer failure");
  });
  const read = vi.fn(() => expect(state.read()?.revision).toBe(1));
  const unsubscribe = state.subscribe(read);
  state.accept(DEFAULT_SERVER_SETTINGS);
  expect(read).toHaveBeenCalledTimes(1);
  unsubscribe();
  state.accept(DEFAULT_SERVER_SETTINGS);
  expect(state.read()?.revision).toBe(2);
  expect(read).toHaveBeenCalledTimes(1);
});
