import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { V2CodingReceipts } from "./Coding.receipts.ts";

it("shared receipt reservations never overshoot capacity or grow on refusal; completed and uncertain history survive", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "v2-receipt-capacity-"));
  try {
    const directory = path.join(profile, "bigbud-coding-receipts");
    await mkdir(directory, { mode: 0o700 });
    const filename = (key: string) =>
      path.join(directory, createHash("sha256").update(key).digest("hex"));
    await writeFile(
      filename("completed"),
      JSON.stringify({ fingerprint: "same", result: { content: "retained" } }),
      { mode: 0o600 },
    );
    await writeFile(filename("uncertain"), JSON.stringify({ fingerprint: "same" }), {
      mode: 0o600,
    });
    for (let start = 0; start < 3997; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 3997 - start) }, (_, index) =>
          writeFile(
            filename(`retained-${start + index}`),
            JSON.stringify({ fingerprint: "retained" }),
            { mode: 0o600 },
          ),
        ),
      );
    }
    const handles = await Promise.all([
      V2CodingReceipts.open(profile),
      V2CodingReceipts.open(profile),
    ]);
    let operations = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        handles[index % 2]!.run(`concurrent-${index}`, "same", async () => {
          operations++;
          return { content: "winner" };
        }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(operations).toBe(1);
    expect(await readdir(directory)).toHaveLength(4000);
    for (let start = 0; start < 100; start += 20) {
      const refused = await Promise.allSettled(
        Array.from({ length: 20 }, (_, index) =>
          handles[index % 2]!.run(`over-cap-${start + index}`, "same", async () => {
            operations++;
            return {};
          }),
        ),
      );
      for (const result of refused) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected")
          expect(result.reason.message).toContain("capacity reached");
      }
      expect(await readdir(directory)).toHaveLength(4000);
    }
    expect(operations).toBe(1);
    const reopened = await V2CodingReceipts.open(profile);
    expect(
      await reopened.run("completed", "same", async () => {
        operations++;
        return {};
      }),
    ).toEqual({ content: "retained" });
    await expect(
      reopened.run("uncertain", "same", async () => {
        operations++;
        return {};
      }),
    ).rejects.toThrow("unconfirmed");
    expect(operations).toBe(1);
    expect(await readdir(directory)).toHaveLength(4000);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}, 30_000);
