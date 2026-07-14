import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { cleanupHandoffDocumentFiles, HANDOFF_DOCUMENT_RETENTION_MS } from "./wsHandoffDocument.ts";

describe("cleanupHandoffDocumentFiles", () => {
  it.effect("removes only Markdown handoff files older than the retention window", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bigbud-handoff-cleanup-"));
      const staleMarkdown = path.join(tempDir, "stale.md");
      const boundaryMarkdown = path.join(tempDir, "boundary.md");
      const recentMarkdown = path.join(tempDir, "recent.MD");
      const staleText = path.join(tempDir, "stale.txt");
      const nestedDir = path.join(tempDir, "nested");
      const nestedMarkdown = path.join(nestedDir, "stale.md");
      const now = new Date("2026-07-13T20:00:00.000Z");
      const staleAt = new Date(now.getTime() - HANDOFF_DOCUMENT_RETENTION_MS - 1_000);
      const boundaryAt = new Date(now.getTime() - HANDOFF_DOCUMENT_RETENTION_MS);
      const recentAt = new Date(now.getTime() - 60_000);

      try {
        fs.writeFileSync(staleMarkdown, "stale");
        fs.writeFileSync(boundaryMarkdown, "boundary");
        fs.writeFileSync(recentMarkdown, "recent");
        fs.writeFileSync(staleText, "not a handoff document");
        fs.mkdirSync(nestedDir);
        fs.writeFileSync(nestedMarkdown, "nested stale");
        fs.utimesSync(staleMarkdown, staleAt, staleAt);
        fs.utimesSync(boundaryMarkdown, boundaryAt, boundaryAt);
        fs.utimesSync(recentMarkdown, recentAt, recentAt);
        fs.utimesSync(staleText, staleAt, staleAt);
        fs.utimesSync(nestedMarkdown, staleAt, staleAt);

        yield* cleanupHandoffDocumentFiles({ directory: tempDir, now });

        assert.isFalse(fs.existsSync(staleMarkdown));
        assert.isTrue(fs.existsSync(boundaryMarkdown));
        assert.isTrue(fs.existsSync(recentMarkdown));
        assert.isTrue(fs.existsSync(staleText));
        assert.isTrue(fs.existsSync(nestedMarkdown));
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("tolerates a missing handoff directory", () =>
    Effect.gen(function* () {
      const missingDirectory = path.join(
        os.tmpdir(),
        `bigbud-missing-handoff-${crypto.randomUUID()}`,
      );

      yield* cleanupHandoffDocumentFiles({ directory: missingDirectory });
      assert.isFalse(fs.existsSync(missingDirectory));
    }),
  );
});
