import { expect, it } from "vitest";
import { assertSetupGraphSeparation } from "./localSupervisorService.setup.validation.ts";
const mutable = [
  "/home/account/backend",
  "/home/account/backend/userdata",
  "/home/account/.bigbud/agent",
  "/home/account/.bigbud/backend-services/authority",
];
it("rejects both ancestor and descendant overlap for every mutable service root", () => {
  for (const path of mutable) {
    expect(() => assertSetupGraphSeparation(path, mutable)).toThrow("outside mutable");
    expect(() => assertSetupGraphSeparation(`${path}/runtime`, mutable)).toThrow("outside mutable");
  }
  expect(() => assertSetupGraphSeparation("/home/account", mutable)).toThrow("outside mutable");
});
it("permits a read-only runtime under the broader OS home beside mutable service state", () => {
  expect(() => assertSetupGraphSeparation("/home/account/runtime-public", mutable)).not.toThrow();
  expect(() => assertSetupGraphSeparation("/home/account/backend-other", mutable)).not.toThrow();
});
