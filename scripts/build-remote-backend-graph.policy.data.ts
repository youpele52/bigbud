/** Checked-in loader policy for the remote backend executable graph (reviewed 17 Nov 2026).
 * Every entry is a reviewed exception. After a dependency or bundle change, run
 * `bun run remote-backend-graph --list-loader-sites ...` to print the member and hash of each
 * unreviewed site, review the code, then update the entry. A hash pins the whole bundle region
 * or file, so unrelated edits inside the same region also need a fresh review. Region hashes
 * cover a canonical text that ignores consistent renaming of bindings (see
 * `build-remote-backend-graph.regionHash.ts`). On 18 Nov 2026 the canonicalization was extended
 * to unsuffixed region-declared names and every region pin was re-pinned: each region's canonical
 * text from the reviewed M1 build (whose raw text matched the earlier pins) equals the canonical
 * text of a clean HEAD build, byte for byte. Later on 18 Nov 2026 file bindings referenced from a
 * region were relabelled by first appearance instead of by spelling, because rolldown renames
 * them between builds (`process$1` ↔ `ob`); the six regions that refer to file bindings were
 * re-pinned after checking that their new canonical text is the reviewed canonical text with only
 * those labels renamed. On 18 Nov 2026 the server build moved to rolldown 1.1.5 and the msgpackr
 * `unpack.js`/`struct.js` and Claude agent SDK regions were re-pinned after a security re-review
 * of the rc.3 and 1.1.5 builds: msgpackr only splits declarator lists (and gains a `@__PURE__`
 * comment); the SDK region only drops dead code, inlines single-use values and folds calls to
 * empty functions, and every loader site keeps the same arguments resolving to the same bindings
 * (docs/reports/2026-11-18-tsdown-rolldown-1.1.5.md, "Security re-review"). */
const loader = (member: string, sha256: string, reason: string, roots: string[] = []) => ({
  member,
  sha256,
  reason,
  roots,
});
const pi = "node_modules/@earendil-works/pi-coding-agent/dist/bundle";

export const BACKEND_GRAPH_LOADER_POLICY_DATA = {
  revision: 1,
  createRequireShim: "import.meta.url-only",
  reviewedDynamicLoaders: [
    // bigbud bundle regions named by the M1 plan.
    loader(
      "src/provider/Layers/Copilot/Runtime.executable.ts",
      "bbc9189662576361b9d893ba703622cc59b2fd572b65ab6a621216d744536e3c",
      "Locates the Copilot SDK platform runtime package beside the graph's @github/copilot-sdk; npm-shim fallback is Windows-only.",
    ),
    loader(
      "src/provider/Layers/Copilot/Adapter.types.cli.ts",
      "14857f59fda9f1423588f9001e3609cb1d21cd5cb47aca0ce591004dc3d031d9",
      "Resolves the optional standalone @github/copilot CLI; absent from the graph, so the caught failure falls back to the SDK runtime.",
    ),
    loader(
      "src/provider/Layers/Pi/Cli.ts",
      "9c4de83408a1f05438f604e1bad40fb9ceb323e939b5cfba0da90e8cb10b86e3",
      "Finds the bundled Pi CLI beside its rpc-entry export and spawns it with the graph's private Node.",
      ["node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"],
    ),
    // Inlined third-party regions of the server bundle.
    loader(
      "msgpackr/unpack.js",
      "15bff2e606ca40b410bb609715fd83f0819ef28f342a8e43356d8dd278645226",
      "msgpackr record readers generated from decoded field names; generates object literals, loads no modules.",
    ),
    loader(
      "msgpackr/struct.js",
      "786e8edea024ebddc826226c8b8f923c4c2e21bcfe0d8777dcf738e9b07de0be",
      "msgpackr struct accessor code generation and a CSP probe; loads no modules.",
    ),
    loader(
      "node-gyp-build-optional-packages/node-gyp-build.js",
      "c5cbd62e7396425edd527aedce61cc5bb2ce7187f7d642a86d5b7112817b84d0",
      "msgpackr's optional msgpackr-extract native lookup; the package is absent and msgpackr falls back to JavaScript.",
    ),
    loader(
      "@anthropic-ai/claude-agent-sdk/sdk.mjs",
      "e17af7aa0bff3353f0ded5d73ea8a03adb2079736d862208855dafde5bbaf3f5",
      "Claude agent SDK: ajv schema-validator codegen, a globalThis probe, and a native CLI lookup used only without pathToClaudeCodeExecutable (absent here, typed error).",
    ),
    // Pi closure, reached through the reviewed Pi CLI root and its rpc-entry export.
    loader(
      `${pi}/chunks/chunk-4GGCU36O.js`,
      "375a2f235e159c680f0b44eb4135ed1dc79cf3f51bff3fe0b2cba29ed1be5029",
      "Pi lazy node-only module import helper (TypeScript extension rewrite); used for user extensions and built-ins.",
    ),
    loader(
      `${pi}/chunks/chunk-UKVNB6C4.js`,
      "2c7346b9cc489160ffc9bf59e36b4016ff28ca1005eb818f2bad5370f1a08941",
      "Pi lazy dynamic import helper for node:fs/os/path in its browser-safe AI layer.",
    ),
    loader(
      `${pi}/chunks/chunk-T726RZZU.js`,
      "b09f9387bb838ee733d15a63d1af07876e0932381c2a9b7d42f74f22cd4d2947",
      "pi-tui native platform helper lookup (clipboard/X11); target addon listed below, failures are caught.",
    ),
    loader(
      `${pi}/chunks/chunk-MM3LKT73.js`,
      "aa4c8b091657bda611f6fd58343561fa44cda1070ae4cd5dbd09ffe1d9a34aab",
      "Pi provider SDK lazy imports and workspace-or-package entry resolution for its code-mode runtime.",
    ),
    loader(
      `${pi}/chunks/jiti-loader-GL4HJFAD.js`,
      "be2d0f1bb460e726bf4e1df1c0d20955f673f1ffa192435fd65440aa6073f38f",
      "Pi's bundled jiti loads user-configured extensions from the user's paths, by design outside the graph.",
    ),
    loader(
      "node_modules/jiti/lib/jiti.cjs",
      "a80e7f04d21d4ef5c540287e41d6ab36dbff73132620e1894cd83425bb1e62a7",
      "jiti native-import bridge for user extension modules.",
    ),
    loader(
      "node_modules/jiti/dist/jiti.cjs",
      "a0b3b8d5e06a0519c66b62179e29200533057920f6f11370546e979dacd24c49",
      "jiti require factory for user extension modules.",
    ),
    loader(
      "node_modules/@silvia-odwyer/photon-node/photon_rs.js",
      "d60656705f0d59baa79e36b0381eb023f1864eeb57e92956cf21dcd9fb8f879f",
      "wasm-bindgen glue: the WebAssembly module asks JS to evaluate fixed snippets; loads no modules.",
    ),
    // Copilot SDK dependency koffi selects its platform package and addon at runtime.
    loader(
      "node_modules/koffi/src/koffi/index.cjs",
      "3135201866d6611f4e47c7976140409c3d6a69a4c77f201f18543518764407f3",
      "koffi loads @koromix/koffi-<platform> by computed name; only the target package is installed.",
    ),
    loader(
      "node_modules/@koromix/koffi-linux-arm64/index.js",
      "69a7171167cc81c4430c2e9fbe4a8639301db0c8491636b0899bc3222671a0a4",
      "koffi platform package picks its glibc or musl koffi.node; the glibc addon is listed, musl is pruned.",
    ),
    loader(
      "node_modules/@koromix/koffi-linux-x64/index.js",
      "bc2f07482a5f5e84623d1601836102fddcf51e48a62657c48409fee57daf8097",
      "koffi platform package picks its glibc or musl koffi.node; the glibc addon is listed, musl is pruned.",
    ),
  ],
  absentOptionalExternals: [
    // Decision 4: no node-pty or Playwright in the remote graph; their callers are lazy.
    "node-pty",
    "playwright",
    "playwright-core",
    // Bun-only Effect adapters and worker, selected only when `process.versions.bun` is set.
    "@effect/*-bun",
    "./BunSqliteReadWorker.ts",
    // Optional accelerators loaded inside try/catch with pure-JS fallbacks.
    "msgpackr-extract",
    "bufferutil",
    "utf-8-validate",
    // The standalone Copilot CLI package; the graph ships the SDK runtime instead.
    "@github/copilot",
    // koffi names every platform package; npm installs only the target's.
    "@koromix/koffi-*",
    // Pi's bundled jiti copy points at jiti's own dist layout; used only to transpile user
    // TypeScript extensions, inside a lazy loader.
    "../dist/babel.cjs",
  ],
  nativeAddons: (["aarch64", "x86_64"] as const).flatMap((cpu) => {
    const target = `${cpu}-unknown-linux-gnu` as const;
    const npm = cpu === "aarch64" ? "arm64" : "x64";
    return [
      {
        pkg: `@github/copilot-sdk-linux-${npm}`,
        target,
        path: `node_modules/@github/copilot-sdk-linux-${npm}/prebuilds/linux-${npm}/runtime.node`,
      },
      {
        pkg: `@koromix/koffi-linux-${npm}`,
        target,
        path: `node_modules/@koromix/koffi-linux-${npm}/linux_${npm}/koffi.node`,
      },
      {
        // Needs libxcb at load time; pi-tui catches the failure on headless hosts.
        pkg: "@earendil-works/pi-tui",
        target,
        path: `node_modules/@earendil-works/pi-tui/native/linux/prebuilds/linux-${npm}/linux-platform-x11.node`,
      },
    ];
  }),
};
