import { expect, it, vi } from "vitest";

const writeSync = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ writeSync }));

import { writeStartupStatus } from "./startupStatus";

it("writes one NDJSON startup status record only when the inherited fd is configured", () => {
  const original = process.env.BIGBUD_STARTUP_STATUS_FD;
  process.env.BIGBUD_STARTUP_STATUS_FD = "4";
  writeStartupStatus("upgrading");
  expect(writeSync).toHaveBeenCalledWith(4, '{"status":"upgrading"}\n');
  writeStartupStatus("error", "projection_database_initialization_failed");
  expect(writeSync).toHaveBeenLastCalledWith(
    4,
    '{"reason":"projection_database_initialization_failed","status":"error"}\n',
  );
  delete process.env.BIGBUD_STARTUP_STATUS_FD;
  writeStartupStatus("ready");
  expect(writeSync).toHaveBeenCalledTimes(2);
  if (original === undefined) delete process.env.BIGBUD_STARTUP_STATUS_FD;
  else process.env.BIGBUD_STARTUP_STATUS_FD = original;
});
