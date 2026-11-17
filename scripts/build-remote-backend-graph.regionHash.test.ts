import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseGraphModule } from "./build-remote-backend-graph.reachability.ts";

const marker = "//#region ../../node_modules/x/load.js";
const digest = (prelude: string, region: string) => {
  const sites = parseGraphModule(
    "server/chunk.mjs",
    `${prelude}\n${marker}\n${region}\n//#endregion\n`,
  ).sites;
  expect(sites.length).toBeGreaterThan(0);
  return sites[0]!.sha256;
};
const loader = (name: string) => `export const f = (n) => ${name}.isAbsolute(n) && import(n);`;
const both = (a: string, b: string) =>
  `export const f = (n) => ${a}.isAbsolute(n) && ${b}.isAbsolute(n) && import(n);`;
const declare = "import { posix as posix$1, posix as posix$2 } from 'node:path';";

describe("canonical loader region digests", () => {
  it("ignores bundle-wide $n renames of bindings, keeping the raw digest when none occur", () => {
    expect(digest(declare, loader("posix$2"))).toBe(digest(declare, loader("posix$1")));
    const plain = `export const f = (n) => import(n);`;
    expect(digest("", plain)).toBe(
      createHash("sha256").update(`${marker}\n${plain}\n//#endregion`).digest("hex"),
    );
  });

  it("still pins distinct bindings, property keys, strings and undeclared globals", () => {
    // Distinct names stay distinct: merging two bindings into one is a reviewed change.
    expect(digest(declare, both("posix$1", "posix$2"))).not.toBe(
      digest(declare, both("posix$1", "posix$1")),
    );
    for (const [before, after] of [
      ["o.posix$1", "o.posix$2"],
      ["({ posix$1 })", "({ posix$2 })"],
      ['"posix$1"', '"posix$2"'],
      ["global$1", "global$2"],
    ] as const)
      expect(digest(declare, loader(before)), `${before} → ${after}`).not.toBe(
        digest(declare, loader(after)),
      );
  });
});
