import { describe, expect, it } from "vitest";

import rootPackageJson from "../../../package.json" with { type: "json" };
import serverPackageJson from "../package.json" with { type: "json" };
import { resolveServerPublishDependencies } from "./cli.publishManifest.ts";

const catalog = rootPackageJson.workspaces.catalog;

describe("resolveServerPublishDependencies", () => {
  it("omits only the bundled private dependency and resolves the server workspace catalog", () => {
    const source = Object.freeze({ ...serverPackageJson.dependencies });
    const { "effect-acp": effectAcp, ...runtimeDependencies } = source;
    expect(effectAcp).toBe("workspace:*");
    expect(resolveServerPublishDependencies(source, catalog)).toEqual({
      ...runtimeDependencies,
      "@effect/platform-bun": catalog["@effect/platform-bun"],
      "@effect/platform-node": catalog["@effect/platform-node"],
      "@effect/sql-sqlite-bun": catalog["@effect/sql-sqlite-bun"],
      effect: catalog.effect,
    });
  });

  it.each([
    ["unreviewed-package", "workspace:*"],
    ["unreviewed-package", "workspace:effect-acp@*"],
    ["@bigbud/private-package", "1.0.0"],
    ["unreviewed-package", "npm:@bigbud/private-package@1.0.0"],
    ["unreviewed-package", "npm:effect-acp@1.0.0"],
    ["unreviewed-package", "file:../../packages/private-package"],
    ["unreviewed-package", "../../packages/private-package"],
    ["unreviewed-package", "private-package.tgz"],
    ["effect-acp", "1.0.0"],
  ])("rejects %s with spec %s instead of stripping or publishing it", (name, spec) => {
    expect(() => resolveServerPublishDependencies({ [name]: spec }, catalog)).toThrow(
      `publish dependency '${name}': '${spec}'`,
    );
  });

  it("rejects workspace references returned by the catalog", () => {
    expect(() =>
      resolveServerPublishDependencies({ runtime: "catalog:alias" }, { alias: "workspace:*" }),
    ).toThrow("Unsupported publish dependency 'runtime': 'workspace:*'");
  });

  it("rejects missing catalog entries", () => {
    expect(() => resolveServerPublishDependencies({ runtime: "catalog:missing" }, {})).toThrow(
      "Unable to resolve 'catalog:missing'",
    );
  });
});
