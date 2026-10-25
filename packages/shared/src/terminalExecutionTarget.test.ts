import { describe, expect, it } from "vitest";
import {
  isWslTerminalTargetId,
  isWslDistributionName,
  parseWslTerminalTargetId,
  wslTerminalTargetId,
} from "./terminalExecutionTarget";

describe("terminal-only WSL identity", () => {
  it.each([
    "Ubuntu",
    "Ubuntu dev",
    "-option",
    'distro & %PATH% "quoted"',
    "Linux-日本語",
    "Linux-🌍",
  ])("round trips exact registered name %s", (name) => {
    const id = wslTerminalTargetId(name);
    expect(parseWslTerminalTargetId(id)).toBe(name);
  });
  it.each(["bad\ud800", "bad\udfff", "bad\ud800x"])(
    "rejects malformed UTF-16 before encoding a distro name",
    (name) => {
      expect(isWslDistributionName(name)).toBe(false);
      expect(() => wslTerminalTargetId(name)).toThrow("Invalid WSL distribution name");
    },
  );
  it.each(["wsl:", "wsl:%GG", "wsl:Ubuntu%20", "wsl:%55buntu", "wsl:a%00b", "wsl:a%0Ab"])(
    "fails closed for %s",
    (id) => {
      expect(isWslTerminalTargetId(id)).toBe(true);
      expect(parseWslTerminalTargetId(id)).toBeNull();
    },
  );
  it.each([undefined, "local", "ssh:host=box", "unknown:box"])(
    "never classifies %s as WSL",
    (id) => {
      expect(isWslTerminalTargetId(id)).toBe(false);
      expect(parseWslTerminalTargetId(id)).toBeNull();
    },
  );
});
