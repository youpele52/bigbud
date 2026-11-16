import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  fileURLToPath(new URL("../../../marketing/public/remote-agent.sh", import.meta.url)),
  "utf8",
);
const fetchFunction = script.slice(
  script.indexOf("bounded_fetch() {"),
  script.indexOf("\nrelease_url="),
);

describe.skipIf(process.platform === "win32")("manual remote download actual-byte bounds", () => {
  for (const downloader of ["curl", "wget"]) {
    it.each([
      { bytes: 1024, exit: 0, success: true },
      { bytes: 1025, exit: 0, success: false },
      { bytes: 256 * 1024, exit: 0, success: false },
      { bytes: 100, exit: 7, success: false },
    ])(`${downloader} bounds output and preserves exit status: %j`, (test) => {
      const root = mkdtempSync(join(tmpdir(), "bigbud-download-bound-"));
      try {
        const fixture = join(root, "fixture");
        const output = join(root, "output");
        writeFileSync(fixture, Buffer.alloc(test.bytes, 65));
        writeFileSync(join(root, downloader), '#!/bin/sh\ncat "$FIXTURE"\nexit "$FETCH_EXIT"\n', {
          mode: 0o700,
        });
        const result = spawnSync(
          "sh",
          [
            "-c",
            `${fetchFunction}\ndownloader=$1\nfetch https://fixture.invalid/artifact 1024 "$2"`,
            "fixture",
            downloader,
            output,
          ],
          {
            env: {
              ...process.env,
              PATH: `${root}:${process.env.PATH}`,
              FIXTURE: fixture,
              FETCH_EXIT: String(test.exit),
            },
            timeout: 5000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status === 0).toBe(test.success);
        expect(readFileSync(output).length).toBeLessThanOrEqual(1025);
        expect(existsSync(`${output}.pipe`)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
