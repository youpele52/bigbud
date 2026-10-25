import { expect, it } from "vitest";
import { resolveOpencodeV2ConnectionMode } from "./serverSettings";

it("defaults sparse settings to shared and preserves legacy private settings until explicit opt-in", () => {
  expect(resolveOpencodeV2ConnectionMode({ binaryPath: "", profileRoot: "" })).toBe("shared");
  const legacy = { binaryPath: "/private/v2", profileRoot: "/private/profile" };
  expect(resolveOpencodeV2ConnectionMode(legacy)).toBe("isolated");
  expect(resolveOpencodeV2ConnectionMode({ ...legacy, connectionMode: "shared" })).toBe("shared");
  expect(legacy).toEqual({ binaryPath: "/private/v2", profileRoot: "/private/profile" });
});
