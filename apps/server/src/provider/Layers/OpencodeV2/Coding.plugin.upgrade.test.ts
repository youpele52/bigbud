import { mkdir, writeFile, readFile, realpath, unlink, link, symlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { withV2RuntimeFixture } from "./Runtime.fixture.ts";
import { makeV2CodingTransport } from "./Coding.transport.ts";
import { renderV2LegacyCodingPlugin } from "./Coding.plugin.legacy.ts";
import { renderV2CodingPlugin } from "./Coding.plugin.ts";
import { renderV2PreviousCodingPlugin } from "./Coding.plugin.previous.ts";

it("freezes the exact previously shipped native-access template", () => {
  expect(
    createHash("sha256")
      .update(renderV2PreviousCodingPlugin("http://127.0.0.1:12345/invoke", "1".repeat(64)))
      .digest("hex"),
  ).toBe("8257d436c59c412b5f7b2fcbb4c55e6ecfa3c209533c5472cf91f121a8a55d75");
});

it.each([renderV2LegacyCodingPlugin, renderV2PreviousCodingPlugin])(
  "exact prior residual owned template atomically upgrades and restart accepts exact current; marker impostors/aliases never accepted",
  async (renderPrior) => {
    await withV2RuntimeFixture(async ({ runtime }) => {
      const profile = await realpath(runtime.options.config.profileRoot),
        directory = path.join(profile, "config", "opencode", "plugins"),
        filename = path.join(directory, "bigbud-coding-owned.js");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const url = "http://127.0.0.1:12345/invoke",
        token = "1".repeat(64),
        legacy = renderPrior(url, token);
      await writeFile(filename, legacy, { mode: 0o600 });
      const first = await makeV2CodingTransport(profile);
      const current = await readFile(filename, "utf8");
      expect(current).toBe(renderV2CodingPlugin(first.endpoint.url, first.endpoint.token));
      expect(current).toContain("host-user authority, not containment");
      expect(current).not.toContain("Native plugins/metadata/shell builtins remain denied");
      const second = await makeV2CodingTransport(profile); // interrupted prior launch left its exact owned template.
      await first.close(); // cannot unlink successor template.
      expect(await readFile(filename, "utf8")).toBe(
        renderV2CodingPlugin(second.endpoint.url, second.endpoint.token),
      );
      await second.close();
      for (const invalid of [legacy + "\n// mutation", legacy.replace(token, "untrusted-token")]) {
        await writeFile(filename, invalid, { mode: 0o600 });
        await expect(makeV2CodingTransport(profile)).rejects.toThrow("upgrade rejected");
        expect(await readFile(filename, "utf8")).toBe(invalid);
        await unlink(filename);
      }
      const alias = path.join(profile, "alias");
      await writeFile(alias, legacy, { mode: 0o600 });
      await link(alias, filename);
      await expect(makeV2CodingTransport(profile)).rejects.toThrow();
      await unlink(filename);
      await symlink(alias, filename);
      await expect(makeV2CodingTransport(profile)).rejects.toThrow();
      expect(await readFile(alias, "utf8")).toBe(legacy);
    });
  },
);
