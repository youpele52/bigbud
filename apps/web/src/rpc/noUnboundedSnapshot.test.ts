import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

/** Production sources only; test fixtures may still answer the legacy tag on their mock sockets. */
function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const skipped =
        ["node_modules", "dist"].includes(entry.name) || entry.name.includes(".browser");
      return skipped ? [] : listSourceFiles(path);
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.(test|browser|fixture|fixtures|helpers|support)\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.test\.[\w.]+\.(ts|tsx)$/.test(entry.name) || entry.name.includes(".browser.")) return [];
    return [path];
  });
}

function findMatches(files: ReadonlyArray<string>, pattern: RegExp): string[] {
  return files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        pattern.test(line) ? [`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`] : [],
      ),
  );
}

describe("no unbounded snapshot reads from client paths", () => {
  it("keeps the web app off the full orchestration snapshot and the mobile thread read", () => {
    const files = listSourceFiles(join(repoRoot, "apps/web/src"));
    expect(files.length).toBeGreaterThan(100);
    expect(
      findMatches(
        files,
        /orchestration\.getSnapshot\b|ORCHESTRATION_WS_METHODS\.getSnapshot\b|getMobileThread\b/,
      ),
    ).toEqual([]);
  });

  it("serves every mobile read without building the full projection snapshot", () => {
    const files = [
      ...listSourceFiles(join(repoRoot, "apps/server/src/mobile")),
      ...listSourceFiles(join(repoRoot, "apps/server/src/ws")).filter((file) =>
        /[\\/]ws\.mobile[\w.]*\.ts$|[\\/]wsMobile[\w.]*\.ts$|[\\/]http\.mobile[\w.]*\.ts$/.test(
          file,
        ),
      ),
    ];
    expect(files.length).toBeGreaterThan(3);
    expect(findMatches(files, /projectionSnapshotQuery\.getSnapshot\b/)).toEqual([]);
  });

  it("keeps the WebSocket RPC surface free of the full snapshot", () => {
    const rpcGroup = readFileSync(join(repoRoot, "packages/contracts/src/server/rpc.ts"), "utf8");
    expect(rpcGroup).not.toMatch(/WsOrchestrationGetSnapshotRpc/);
    const handlers = listSourceFiles(join(repoRoot, "apps/server/src/ws")).filter(
      (file) => !/[\\/]ws\.mobile[\w.]*\.ts$/.test(file),
    );
    expect(findMatches(handlers, /ORCHESTRATION_WS_METHODS\.getSnapshot\b/)).toEqual([]);
  });

  it("limits mobile-web snapshot reads to its legacy-server fallback", () => {
    // The mobile endpoints are bounded on the server; these files are the fallback for older
    // desktop servers without the mobile recovery baseline. New callers must not appear.
    const allowed = new Set([
      "apps/mobile-web/src/lib/mobileRpc.ts",
      "apps/mobile-web/src/logic/mobileRecovery.legacy.ts",
      "apps/mobile-web/src/logic/mobileRecovery.types.ts",
      "apps/mobile-web/src/hooks/useMobileSnapshot.ts",
      "apps/mobile-web/src/hooks/useMobileThread.ts",
    ]);
    const files = listSourceFiles(join(repoRoot, "apps/mobile-web/src"));
    const callers = findMatches(files, /\.getSnapshot\(|\.getMobileThread\(|"getSnapshot"/)
      .map((match) => match.split(":")[0]!)
      .filter((file) => !allowed.has(file.replaceAll("\\", "/")));
    expect(callers).toEqual([]);
  });
});
