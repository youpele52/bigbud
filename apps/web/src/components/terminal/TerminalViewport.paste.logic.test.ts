import { describe, expect, it } from "vitest";
import {
  bytesToBase64,
  planTerminalDrop,
  planTerminalPaste,
  terminalPasteHostKind,
  WSL_PASTE_NOTICE,
} from "./TerminalViewport.paste.logic";

const image = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
  type: "image/png",
});
const finder = new File(["%PDF"], "Quarterly report.pdf", { type: "application/pdf" });

describe("terminal paste classification", () => {
  it("maps execution targets to the machine that runs the terminal", () => {
    expect(terminalPasteHostKind("local")).toBe("local");
    expect(terminalPasteHostKind(undefined)).toBe("local");
    expect(terminalPasteHostKind("ssh:host=vps")).toBe("remote");
    expect(terminalPasteHostKind("wsl:Ubuntu")).toBe("wsl");
  });

  it("leaves text pastes (and text with an image) to xterm unchanged", () => {
    for (const host of ["local", "remote", "wsl"] as const) {
      expect(planTerminalPaste({ text: "echo hi", files: [], host })).toEqual({
        kind: "passthrough",
      });
      expect(
        planTerminalPaste({ text: "caption", files: [{ file: image, nativePath: "" }], host }),
      ).toEqual({ kind: "passthrough" });
    }
  });

  it("stages a bare image locally and remotely", () => {
    for (const host of ["local", "remote"] as const)
      expect(
        planTerminalPaste({ text: "", files: [{ file: image, nativePath: "" }], host }),
      ).toEqual({ kind: "deliver", items: [{ kind: "stage", file: image }] });
  });

  it("pastes the real absolute path of a Finder-copied file locally, ignoring its name text", () => {
    const nativePath = "/Users/me/Documents/Quarterly report.pdf";
    expect(
      planTerminalPaste({
        text: "Quarterly report.pdf",
        files: [{ file: finder, nativePath }],
        host: "local",
      }),
    ).toEqual({ kind: "deliver", items: [{ kind: "path", path: nativePath }] });
    expect(
      planTerminalPaste({
        text: "Quarterly report.pdf",
        files: [{ file: finder, nativePath }],
        host: "remote",
      }),
    ).toEqual({ kind: "deliver", items: [{ kind: "stage", file: finder }] });
  });

  it("never pastes a relative, ~ or bare-name path; it stages those bytes instead", () => {
    for (const nativePath of ["report.pdf", "~/report.pdf", "./report.pdf", ""])
      expect(
        planTerminalPaste({ text: "", files: [{ file: finder, nativePath }], host: "local" }),
      ).toEqual({
        kind: "deliver",
        items: [{ kind: "stage", file: finder }],
      });
  });

  it("keeps several files in order and rejects WSL with a notice", () => {
    const files = [
      { file: image, nativePath: "/tmp/a b.png" },
      { file: finder, nativePath: "" },
    ];
    expect(planTerminalPaste({ text: "", files, host: "local" })).toEqual({
      kind: "deliver",
      items: [
        { kind: "path", path: "/tmp/a b.png" },
        { kind: "stage", file: finder },
      ],
    });
    expect(planTerminalPaste({ text: "", files, host: "wsl" })).toEqual({
      kind: "reject",
      message: WSL_PASTE_NOTICE,
    });
  });

  it("routes remote native drops through staging instead of dropping them", () => {
    const dropped = [
      { path: "/srv/app/README.md", origin: "internal" as const },
      { path: "/Users/me/Desktop/shot 1.png", origin: "native" as const, file: image },
      { path: "relative/x.md", origin: "internal" as const },
    ];
    expect(planTerminalDrop({ dropped, host: "remote" })).toEqual({
      kind: "deliver",
      items: [
        { kind: "path", path: "/srv/app/README.md" },
        { kind: "stage", file: image },
      ],
    });
    expect(planTerminalDrop({ dropped, host: "local" })).toEqual({
      kind: "deliver",
      items: [
        { kind: "path", path: "/srv/app/README.md" },
        { kind: "path", path: "/Users/me/Desktop/shot 1.png" },
      ],
    });
  });

  it("encodes upload chunks as standard base64", () => {
    expect(bytesToBase64(new Uint8Array([0, 1, 2, 250, 251, 252]))).toBe("AAEC+vv8");
    const large = new Uint8Array(100_000).fill(65);
    expect(atob(bytesToBase64(large))).toBe("A".repeat(100_000));
  });
});
