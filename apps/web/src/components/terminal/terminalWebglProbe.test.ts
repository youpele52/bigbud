import { describe, expect, it, vi } from "vitest";
import {
  gateTerminalRenderingPolicy,
  isLinuxRendererHost,
  linuxWebglDenial,
} from "./terminalWebglProbe";

const allowed = { allowed: true, reason: null, webglFeatureStatus: "enabled" };
const hardware = { hasWebgl2: true, renderer: "Mesa Intel(R) Xe Graphics", vendor: "Intel" };

describe("Linux terminal WebGL probe", () => {
  it("accepts hardware GL and rejects software, unidentified or missing WebGL2", () => {
    expect(linuxWebglDenial(hardware)).toBeNull();
    for (const renderer of ["llvmpipe (LLVM 15.0.7, 256 bits)", "Google SwiftShader", "virgl"])
      expect(linuxWebglDenial({ hasWebgl2: true, renderer, vendor: "Mesa" })).toMatch(
        /Software GL/,
      );
    expect(linuxWebglDenial({ hasWebgl2: true, renderer: null, vendor: null })).toMatch(
      /unidentified/,
    );
    expect(linuxWebglDenial({ hasWebgl2: false, renderer: null, vendor: null })).toMatch(/WebGL2/);
  });

  it("gates only allowed policies on Linux hosts", () => {
    const software = vi.fn(() => ({ hasWebgl2: true, renderer: "llvmpipe", vendor: "Mesa" }));
    expect(gateTerminalRenderingPolicy(allowed, { linux: false, probe: software })).toBe(allowed);
    expect(software).not.toHaveBeenCalled();
    const denied = { allowed: false, reason: "disabled", webglFeatureStatus: "disabled_off" };
    expect(gateTerminalRenderingPolicy(denied, { linux: true, probe: software })).toBe(denied);
    expect(gateTerminalRenderingPolicy(allowed, { linux: true, probe: software })).toMatchObject({
      allowed: false,
      webglFeatureStatus: "linux-renderer-probe",
    });
    expect(gateTerminalRenderingPolicy(allowed, { linux: true, probe: () => hardware })).toBe(
      allowed,
    );
  });

  it("detects Linux renderer hosts but not Node test hosts", () => {
    expect(isLinuxRendererHost("Linux x86_64", "Mozilla/5.0 (X11; Linux x86_64)")).toBe(true);
    expect(isLinuxRendererHost("MacIntel", "Mozilla/5.0 (Macintosh)")).toBe(false);
    expect(isLinuxRendererHost("Linux", "Node.js/22")).toBe(false);
  });
});
