import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const generator = fileURLToPath(
  new URL("./generateThreadToolImplementationManifest.ts", import.meta.url),
);
const manifest = fileURLToPath(
  new URL(
    "../src/provider/Layers/OpencodeV2/Orchestration.implementation.manifest.generated.ts",
    import.meta.url,
  ),
);

describe("thread-tool implementation manifest formatter", () => {
  it.each([process.execPath, "bun"])(
    "checks frozen output through %s without package-manager shims",
    (runtime) => {
      const before = readFileSync(manifest, "utf8");
      // Running the real generator covers package resolution and the formatter's
      // stdin/output contract under both Node and Bun, including Windows installs.
      expect(() =>
        execFileSync(runtime, [generator, "--check"], {
          cwd: fileURLToPath(new URL("../", import.meta.url)),
          encoding: "utf8",
          timeout: 30_000,
        }),
      ).not.toThrow();
      expect(readFileSync(manifest, "utf8")).toBe(before);
    },
  );
});
