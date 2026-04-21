import { defineConfig } from "tsdown";

// Packages that MUST remain external and cannot be inlined into the bundle:
// - node-pty: native C++ addon (.node binary + spawn-helper executable); also
//   resolved at runtime via createRequire/require.resolve in NodePTY.ts.
// - @github/copilot-sdk, @github/copilot: CopilotAdapter.types.ts uses
//   require.resolve("@github/copilot-sdk") at runtime to locate the sibling
//   @github/copilot CLI entry point on disk.
// - @mariozechner/pi-coding-agent: PiCli.ts uses createRequire().resolve(...) at
//   runtime to locate Pi's bundled CLI entry point on disk.
// - @effect/sql-sqlite-bun, @effect/platform-bun: Bun-only; wrap bun:sqlite
//   and Bun built-in APIs. Never loaded in an Electron/Node context.
//
// Everything else (effect, @effect/platform-node, @anthropic-ai/claude-agent-sdk,
// @opencode-ai/sdk, @pierre/diffs, open, @bigbud/*) is inlined to produce a
// self-contained bundle that does not require a node_modules tree at runtime.
// This is critical for packaged desktop builds where the server runs under
// Electron's Node.js via ELECTRON_RUN_AS_NODE=1.
const EXTERNAL_PACKAGES = [
  "node-pty",
  "@github/copilot-sdk",
  "@github/copilot",
  "@mariozechner/pi-coding-agent",
  "@effect/sql-sqlite-bun",
  "@effect/platform-bun",
];

function isExternal(id: string): boolean {
  return EXTERNAL_PACKAGES.some((pkg) => id === pkg || id.startsWith(`${pkg}/`));
}

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  // Bundle ALL dependencies into the output except the explicitly external ones.
  // noExternal: true tells the bundler to inline everything by default.
  noExternal: (id) => !isExternal(id),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
