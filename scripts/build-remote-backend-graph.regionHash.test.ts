import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseGraphModule } from "./build-remote-backend-graph.reachability.ts";

const marker = "//#region ../../node_modules/x/load.js";
/** Digest of the region holding the first loader site; `import(n)` makes the site. */
const digest = (prelude: string, region: string) => {
  const sites = parseGraphModule(
    "server/chunk.mjs",
    `${prelude}\n${marker}\n${region}\nimport(n);\n//#endregion\n`,
  ).sites;
  expect(sites.length).toBeGreaterThan(0);
  return sites[0]!.sha256;
};
const same = (a: [string, string], b: [string, string]) =>
  expect(digest(...a), `${a[1]} ≡ ${b[1]}`).toBe(digest(...b));
const differ = (a: [string, string], b: [string, string]) =>
  expect(digest(...a), `${a[1]} ≢ ${b[1]}`).not.toBe(digest(...b));
const declare = "import { posix as posix$1, posix as posix$2 } from 'node:path';";
const loader = (name: string) => `export const f = (n) => ${name}.isAbsolute(n);`;
const read = (name: string) => `function ${name}(n) { return n; }\nconst x = ${name}(1);`;

describe("canonical loader region digests", () => {
  it("ignores bundle-wide renames of free bindings declared elsewhere in the file", () => {
    same([declare, loader("posix$2")], [declare, loader("posix$1")]);
    // Rolldown names a merged external default import after whichever importer it meets first.
    same(
      ['import process$1 from "node:process";', "use(process$1.cwd(), process$1.env);"],
      ['import ob from "node:process";', "use(ob.cwd(), ob.env);"],
    );
    const outer = "const ob = 1, process$1 = 2;";
    same([outer, "use(ob);"], [outer, "use(process$1);"]);
  });

  it("tells file bindings apart within the region, and from globals and locals", () => {
    const outer = "const ob = 1, process$1 = 2;";
    // Two references to one file binding stay equal; to two file bindings stay different.
    same([outer, "use(ob, ob);"], [outer, "use(process$1, process$1);"]);
    differ([outer, "use(ob, process$1);"], [outer, "use(ob, ob);"]);
    differ([outer, "use(ob, process$1);"], [outer, "use(process$1, process$1);"]);
    // File binding versus the global of the same or another spelling.
    differ([outer, "use(process$1);"], ["", "use(process$1);"]);
    differ([outer, "use(ob);"], [outer, "use(process);"]);
    differ([outer, "use(ob, process);"], [outer, "use(ob, ob);"]);
    // File binding versus a region-local binding.
    differ([outer, "use(ob);"], [outer, "let ob; use(ob);"]);
    // A `var` also declared outside the region is a file binding, not a local one.
    differ(["var ob = 1;", "use(ob); var ob;"], ["", "use(ob); var ob;"]);
  });

  it("ignores renames of region-declared bindings, suffixed or not", () => {
    // WP-5C: another chunk freed the name, so `read$2` became `read`.
    same(["", read("read$2")], ["", read("read")]);
    same(["", read("read")], ["", read("whatever")]);
    // Parameters, catch bindings, classes and nested scopes follow the same rule.
    same(
      ["", "class A { m(p) { try { return p; } catch (e) { return e; } } }"],
      ["", "class B { m(q) { try { return q; } catch (f) { return f; } } }"],
    );
  });

  it("keeps the raw digest when the region has no renamed binding", () => {
    const plain = "globalThis.load(n);";
    const region = `${plain}\nimport(n);`;
    expect(digest("", plain)).toBe(
      createHash("sha256").update(`${marker}\n${region}\n//#endregion`).digest("hex"),
    );
  });

  it("never merges distinct bindings, including shadowed ones", () => {
    differ(["", "let a, b; use(a, b);"], ["", "let a, b; use(a, a);"]);
    differ(["", "let a, b; use(a, b);"], ["", "let a, b; use(b, a);"]);
    // An inner binding with the same spelling is a different binding.
    differ(["", "let a; function g(a) { return a; }"], ["", "let a; function g(b) { return a; }"]);
    same(["", "let a; function g(a) { return a; }"], ["", "let x; function g(y) { return y; }"]);
    // The same spelling for two suffixed free bindings stays two bindings.
    differ([declare, loader("posix$1 && posix$2")], [declare, loader("posix$1 && posix$1")]);
  });

  it("never hides a change in what a free name refers to", () => {
    // A free name captured by a new local binding.
    differ(["", "let a; use(b);"], ["", "let b; use(b);"]);
    differ(["", "let a; use(a);"], ["", "let a; use(fetch);"]);
    // A free name that refers to something else: another global, or a file binding.
    differ(["", "use(fetch);"], ["", "use(fetch2);"]);
    differ(["const process = 2;", "use(process);"], ["", "use(process);"]);
    differ([declare, loader("posix$1")], [declare, loader("posix")]);
    // A binding that moved out of the region is no longer local.
    differ(["", "function read() {} read();"], ["function read() {}", "read();"]);
  });

  it("keeps property keys, labels, strings and globals byte-exact", () => {
    const pairs: [string, string][] = [
      ["let a; o.a$1(a);", "let a; o.a$2(a);"],
      ["const o = { k: 1 }; use(o);", "const o = { j: 1 }; use(o);"],
      ["let a; use({ a });", "let b; use({ b });"],
      ["const { a } = o; use(a);", "const { b } = o; use(b);"],
      ['let a; use(a, "a$1");', 'let a; use(a, "a$2");'],
      ["x: for (;;) break x;", "y: for (;;) break y;"],
      ["use(global$1);", "use(global$2);"],
      ["let a; export { a };", "let b; export { b };"],
    ];
    for (const [before, after] of pairs) differ([declare, before], [declare, after]);
  });

  it("relates a key spelled once or twice, and never confuses which binding it holds", () => {
    same(["", "let a; use({ a });"], ["", "let z; use({ a: z });"]);
    same(["", "const { a } = o; use(a);"], ["", "const { a: z } = o; use(z);"]);
    same(["", "let a; export { a };"], ["", "let z; export { z as a };"]);
    differ(["", "let a = 1, b = 2; use({ a });"], ["", "let b = 1, a = 2; use({ a });"]);
  });
});
