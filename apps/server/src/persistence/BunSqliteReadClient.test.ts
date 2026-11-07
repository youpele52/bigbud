import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("isolates usage scans in a read-only worker under the real Bun runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bigbud-bun-usage-"));
  try {
    const fixture = fileURLToPath(
      new URL("./BunSqliteReadClient.runtime.fixture.ts", import.meta.url),
    );
    const { stdout } = await promisify(execFile)(
      "bun",
      [fixture, join(directory, "state.sqlite")],
      {
        timeout: 45_000,
      },
    );
    expect(stdout).toContain("BUN_USAGE_WORKER_OK");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
