import { afterEach, expect, it } from "vitest";
import { useTextGenerationWarnings } from "./textGenerationWarnings.store";

afterEach(() => useTextGenerationWarnings.setState({ owners: new Map() }));
it("retains at most 512 session-only warning identities without replacing an existing display owner", () => {
  const store = useTextGenerationWarnings.getState();
  const original = Symbol("visible");
  store.claim("title:thread", original);
  store.claim("title:thread", Symbol("duplicate"));
  expect(useTextGenerationWarnings.getState().owners.get("title:thread")).toBe(original);
  for (let index = 0; index < 600; index++) store.claim(`thread:${index}`, Symbol());
  expect(useTextGenerationWarnings.getState().owners.size).toBe(512);
  expect(useTextGenerationWarnings.getState().owners.get("title:thread")).toBe(original);
  expect(useTextGenerationWarnings.getState().owners.has("thread:599")).toBe(false);
});
