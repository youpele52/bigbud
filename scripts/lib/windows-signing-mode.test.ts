import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  formatUnsignedWindowsWarning,
  resolveWindowsSigningMode,
  sanitizeUnsignedSigningEnvironment,
  WINDOWS_SIGNING_CONFIGURATION_NAMES,
} from "./windows-signing-mode.ts";

const completeEnvironment = {
  WIN_CSC_LINK: "certificate",
  WIN_CSC_KEY_PASSWORD: "password",
  BIGBUD_WINDOWS_SIGNING_SUBJECT: "CN=bigbud",
};

describe("Windows signing mode", () => {
  it("enables signing only when every setting is present", () => {
    expect(resolveWindowsSigningMode(completeEnvironment)).toEqual({ signed: true, missing: [] });
  });

  it("reports every missing setting when none are present", () => {
    expect(resolveWindowsSigningMode({})).toEqual({
      signed: false,
      missing: WINDOWS_SIGNING_CONFIGURATION_NAMES,
    });
  });

  it.each(WINDOWS_SIGNING_CONFIGURATION_NAMES)("reports %s when it alone is missing", (name) => {
    const environment = { ...completeEnvironment };
    delete environment[name];
    expect(resolveWindowsSigningMode(environment)).toEqual({ signed: false, missing: [name] });
  });

  it("treats blank values as missing without reporting configured names", () => {
    expect(
      resolveWindowsSigningMode({
        WIN_CSC_LINK: "certificate",
        WIN_CSC_KEY_PASSWORD: " ",
      }),
    ).toEqual({
      signed: false,
      missing: ["WIN_CSC_KEY_PASSWORD", "BIGBUD_WINDOWS_SIGNING_SUBJECT"],
    });
  });

  it("sanitizes partial Windows, generic, and Apple signing configuration", () => {
    const environment: NodeJS.ProcessEnv = {
      ...completeEnvironment,
      CSC_LINK: "mac-certificate",
      CSC_KEY_PASSWORD: "mac-password",
      CSC_NAME: "identity",
      APPLE_API_KEY: "key",
      APPLE_API_KEY_ID: "key-id",
      APPLE_API_ISSUER: "issuer",
      KEEP_ME: "safe",
    };

    sanitizeUnsignedSigningEnvironment(environment);

    expect(environment).toEqual({ KEEP_ME: "safe", CSC_IDENTITY_AUTO_DISCOVERY: "false" });
  });

  it("warns with missing names and unsigned trust implications only", () => {
    expect(formatUnsignedWindowsWarning(["WIN_CSC_LINK"])).toBe(
      "Windows artifacts will be unsigned because these settings are missing: WIN_CSC_LINK. Users may see Unknown Publisher and Microsoft Defender SmartScreen prompts.",
    );
  });

  it("writes only safe unsigned outputs, warnings, and summary details", () => {
    const root = mkdtempSync(join(tmpdir(), "bigbud-windows-signing-"));
    const outputPath = join(root, "output");
    const summaryPath = join(root, "summary");

    try {
      const stdout = execFileSync(
        process.execPath,
        [fileURLToPath(new URL("../resolve-windows-signing-mode.ts", import.meta.url))],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_OUTPUT: outputPath,
            GITHUB_STEP_SUMMARY: summaryPath,
            WIN_CSC_LINK: "certificate-must-not-be-logged",
            WIN_CSC_KEY_PASSWORD: "",
            BIGBUD_WINDOWS_SIGNING_SUBJECT: "",
          },
        },
      );

      expect(readFileSync(outputPath, "utf8")).toBe(
        "signed=false\nmissing=WIN_CSC_KEY_PASSWORD,BIGBUD_WINDOWS_SIGNING_SUBJECT\n",
      );
      expect(`${stdout}${readFileSync(summaryPath, "utf8")}`).toContain(
        "Unknown Publisher and Microsoft Defender SmartScreen prompts",
      );
      expect(`${stdout}${readFileSync(summaryPath, "utf8")}`).not.toContain(
        "certificate-must-not-be-logged",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
