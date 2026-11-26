import { expect, it } from "vitest";
import { piVersionCapabilities } from "./RpcProcess.version.ts";

it.each([
  ["0.80.3", false, false],
  ["0.80.4", true, false],
  ["0.81.0", true, false],
  ["0.98.9", true, false],
  ["0.99.0", true, true],
  ["pi v1.4.0", true, true],
  ["2.0.0", true, true],
])("detects independent capabilities in %s", (version, settled, disposition) => {
  expect(piVersionCapabilities(String(version))).toEqual({
    supportsAgentSettled: settled,
    supportsPromptDisposition: disposition,
  });
});
