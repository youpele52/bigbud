// Adapted from Orca (stablyai/orca, MIT) terminal-webgl-auto-policy.ts at be4e0719. Wayland is
// denied by the desktop policy (it knows the display server); this probe covers Linux GL identity.
import type { TerminalRenderingPolicy } from "@bigbud/contracts/server/ipc.terminal";

const LINUX_SOFTWARE_RENDERER_PATTERN =
  /\b(swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|basic render|virgl|svga3d)\b/i;

export interface WebglRendererInfo {
  readonly hasWebgl2: boolean;
  readonly renderer: string | null;
  readonly vendor: string | null;
}

export function isLinuxRendererHost(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  if (userAgent.startsWith("Node.js/")) return false;
  return platform.includes("Linux") || userAgent.includes("Linux");
}

function readWebglRendererInfo(): WebglRendererInfo {
  const none = { hasWebgl2: false, renderer: null, vendor: null };
  if (typeof document === "undefined") return none;
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return none;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    if (!debug) return { hasWebgl2: true, renderer: null, vendor: null };
    const renderer = String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? "");
    const vendor = String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) ?? "");
    return { hasWebgl2: true, renderer: renderer || null, vendor: vendor || null };
  } catch {
    return none;
  } finally {
    // The probe must not hold one of the renderer process's 16 live contexts.
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/** Why a Linux GL stack cannot host xterm's WebGL renderer, or null when it is hardware GL. */
export function linuxWebglDenial(info: WebglRendererInfo): string | null {
  if (!info.hasWebgl2) return "WebGL2 is unavailable on this Linux GL stack.";
  if (!info.renderer && !info.vendor)
    // Without renderer identity, software GL (which corrupts glyphs) cannot be ruled out.
    return "The Linux GL renderer is unidentified; terminal uses DOM.";
  if (LINUX_SOFTWARE_RENDERER_PATTERN.test(`${info.vendor ?? ""} ${info.renderer ?? ""}`))
    return `Software GL renderer (${info.renderer ?? info.vendor}); terminal uses DOM.`;
  return null;
}

let cachedDenial: { value: string | null } | null = null;

/** Linux only: an allowed application policy is still denied for software or unknown GL. */
export function gateTerminalRenderingPolicy(
  policy: TerminalRenderingPolicy,
  options: { linux?: boolean; probe?: () => WebglRendererInfo } = {},
): TerminalRenderingPolicy {
  if (!policy.allowed || !(options.linux ?? isLinuxRendererHost())) return policy;
  const denial = options.probe
    ? linuxWebglDenial(options.probe())
    : (cachedDenial ??= { value: linuxWebglDenial(readWebglRendererInfo()) }).value;
  return denial === null
    ? policy
    : { allowed: false, reason: denial, webglFeatureStatus: "linux-renderer-probe" };
}
