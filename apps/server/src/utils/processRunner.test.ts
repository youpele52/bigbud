import { describe, expect, it } from "vitest";

import { runProcess } from "./processRunner";

describe("runProcess", () => {
  it("reports stdout progress without changing retained output", async () => {
    const chunks: string[] = [];
    const result = await runProcess(
      "node",
      ["-e", "process.stdout.write('ready'); process.stderr.write('warning')"],
      {
        onStdoutChunk: (chunk) => chunks.push(chunk),
      },
    );
    expect(chunks.join("")).toBe("ready");
    expect(result.stdout).toBe("ready");
    expect(result.stderr).toBe("warning");
  });

  it("fails safely if an output observer throws", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('ready')"], {
        onStdoutChunk: () => {
          throw new Error("observer failed");
        },
      }),
    ).rejects.toThrow("observer failed");
  });
  it("fails when output exceeds max buffer in default mode", async () => {
    await expect(
      runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], { maxBufferBytes: 128 }),
    ).rejects.toThrow("exceeded stdout buffer limit");
  });

  it("truncates output when outputMode is truncate", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxBufferBytes: 128,
      outputMode: "truncate",
    });

    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });
});
