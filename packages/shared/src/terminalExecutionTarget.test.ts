import { describe, expect, it } from "vitest";
import {
  isWslTerminalTargetId,
  parseWslTerminalTargetId,
  wslTerminalTargetId,
} from "./terminalExecutionTarget";

describe("terminal-only WSL identity", () => {
  it.each(["Ubuntu", "Ubuntu dev", "-option", 'distro & %PATH% "quoted"', "Linux-日本語"])(
    "round trips exact registered name %s",
    (name) => {
      const id = wslTerminalTargetId(name);
      expect(parseWslTerminalTargetId(id)).toBe(name);
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
