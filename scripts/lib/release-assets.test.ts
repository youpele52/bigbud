import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { collectDesktopReleaseAssets, verifyAssembledDesktopReleaseAssets } from "./release-assets";

describe("desktop release assets", () => {
  it.each(["latest", "beta", "preview", "nightly"] as const)(
    "collects and renames the active %s manifest",
    (updateChannel) => {
      const root = mkdtempSync(join(tmpdir(), "bigbud-release-assets-"));
      const sourceDirectory = join(root, "source");
      const destinationDirectory = join(root, "destination");
      mkdirSync(sourceDirectory);
      writeFileSync(join(sourceDirectory, `${updateChannel}-mac.yml`), "version: 1.2.3\n");
      writeFileSync(join(sourceDirectory, "bigbud-1.2.3-x64.dmg"), "dmg");
      writeFileSync(join(sourceDirectory, "latest-mac.yml"), "wrong channel");

      const copied = collectDesktopReleaseAssets({
        architecture: "x64",
        destinationDirectory,
        platform: "mac",
        sourceDirectory,
        updateChannel,
      });

      expect(copied).toContain(join(destinationDirectory, `${updateChannel}-mac-x64.yml`));
      if (updateChannel !== "latest") {
        expect(copied).not.toContain(join(destinationDirectory, "latest-mac.yml"));
      }
    },
  );

  it("normalizes Linux x64 artifact names and updater references", () => {
    const root = mkdtempSync(join(tmpdir(), "bigbud-release-assets-"));
    const sourceDirectory = join(root, "source");
    const destinationDirectory = join(root, "destination");
    mkdirSync(sourceDirectory);
    writeFileSync(join(sourceDirectory, "bigbud-preview-x86_64.AppImage"), "appimage");
    writeFileSync(join(sourceDirectory, "bigbud-preview-amd64.deb"), "deb");
    writeFileSync(
      join(sourceDirectory, "preview-linux.yml"),
      "url: bigbud-preview-x86_64.AppImage\n",
    );

    const copied = collectDesktopReleaseAssets({
      architecture: "x64",
      destinationDirectory,
      platform: "linux",
      sourceDirectory,
      updateChannel: "preview",
    });

    expect(copied).toEqual(
      expect.arrayContaining([
        join(destinationDirectory, "bigbud-preview-x64.AppImage"),
        join(destinationDirectory, "bigbud-preview-x64.deb"),
        join(destinationDirectory, "preview-linux.yml"),
      ]),
    );
    expect(readFileSync(join(destinationDirectory, "preview-linux.yml"), "utf8")).toContain(
      "bigbud-preview-x64.AppImage",
    );
  });

  it("requires the complete assembled payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-assembled-assets-"));
    const files = [
      "install.sh",
      "install.ps1",
      "bigbud-preview-arm64.dmg",
      "bigbud-preview-x64.dmg",
      "bigbud-preview-arm64.zip",
      "bigbud-preview-x64.zip",
      "bigbud-preview-x64.AppImage",
      "bigbud-preview-x64.deb",
      "bigbud-preview-x64.exe",
      "bigbud-preview-arm64.zip.blockmap",
      "bigbud-preview-x64.zip.blockmap",
      "bigbud-preview-x64.exe.blockmap",
      "server-workspace-agent-darwin-arm64",
      "server-workspace-agent-darwin-x64",
      "server-workspace-agent-linux-x64",
      "server-workspace-agent-win32-x64.exe",
    ];
    for (const name of files) {
      writeFileSync(join(directory, name), name);
    }
    writeFileSync(
      join(directory, "preview-mac.yml"),
      "urls: [bigbud-preview-arm64.zip, bigbud-preview-x64.zip]\n",
    );
    writeFileSync(join(directory, "preview-linux.yml"), "url: bigbud-preview-x64.AppImage\n");
    writeFileSync(join(directory, "preview.yml"), "url: bigbud-preview-x64.exe\n");

    expect(() => verifyAssembledDesktopReleaseAssets(directory, "preview")).not.toThrow();
  });

  it("does not treat the Windows watcher as the desktop installer", () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-assembled-assets-"));
    for (const name of [
      "install.sh",
      "install.ps1",
      "preview-mac.yml",
      "preview-linux.yml",
      "preview.yml",
      "bigbud-preview-arm64.dmg",
      "bigbud-preview-x64.dmg",
      "bigbud-preview-arm64.zip",
      "bigbud-preview-x64.zip",
      "bigbud-preview-x64.AppImage",
      "bigbud-preview-x64.deb",
      "bigbud-preview-arm64.zip.blockmap",
      "bigbud-preview-x64.zip.blockmap",
      "server-workspace-agent-darwin-arm64",
      "server-workspace-agent-darwin-x64",
      "server-workspace-agent-linux-x64",
      "server-workspace-agent-win32-x64.exe",
    ]) {
      writeFileSync(join(directory, name), name);
    }

    expect(() => verifyAssembledDesktopReleaseAssets(directory, "preview")).toThrow(
      "Missing assembled release artifact: *-x64.exe",
    );
  });

  it("rejects a Linux updater manifest overwritten by the deb fallback", () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-assembled-assets-"));
    for (const name of [
      "install.sh",
      "install.ps1",
      "bigbud-preview-arm64.dmg",
      "bigbud-preview-x64.dmg",
      "bigbud-preview-arm64.zip",
      "bigbud-preview-x64.zip",
      "bigbud-preview-x64.AppImage",
      "bigbud-preview-x64.deb",
      "bigbud-preview-x64.exe",
      "bigbud-preview-arm64.zip.blockmap",
      "bigbud-preview-x64.zip.blockmap",
      "bigbud-preview-x64.exe.blockmap",
      "server-workspace-agent-darwin-arm64",
      "server-workspace-agent-darwin-x64",
      "server-workspace-agent-linux-x64",
      "server-workspace-agent-win32-x64.exe",
    ]) {
      writeFileSync(join(directory, name), name);
    }
    writeFileSync(
      join(directory, "preview-mac.yml"),
      "urls: [bigbud-preview-arm64.zip, bigbud-preview-x64.zip]\n",
    );
    writeFileSync(join(directory, "preview-linux.yml"), "url: bigbud-preview-x64.deb\n");
    writeFileSync(join(directory, "preview.yml"), "url: bigbud-preview-x64.exe\n");

    expect(() => verifyAssembledDesktopReleaseAssets(directory, "preview")).toThrow(
      "Update manifest preview-linux.yml does not reference *-x64.AppImage",
    );
  });

  it("rejects a stale or cross-channel updater manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "bigbud-assembled-assets-"));
    for (const name of [
      "install.sh",
      "install.ps1",
      "preview-mac.yml",
      "preview-linux.yml",
      "preview.yml",
      "latest.yml",
    ]) {
      writeFileSync(join(directory, name), name);
    }

    expect(() => verifyAssembledDesktopReleaseAssets(directory, "preview")).toThrow(
      "Unexpected update manifest: latest.yml",
    );
  });
});
