/** Checked-in loader policy for the remote backend executable graph (reviewed 17 Nov 2026).
 * Every entry is a reviewed exception. After a dependency or bundle change, run
 * `bun run remote-backend-graph --list-loader-sites ...` to print the member and hash of each
 * unreviewed site, review the code, then update the entry. A hash pins the whole bundle region
 * or file, so unrelated edits inside the same region also need a fresh review. Region hashes
 * cover a canonical text that ignores consistent renaming of bindings (see
 * `build-remote-backend-graph.regionHash.ts`). On 18 Nov 2026 the canonicalization was extended
 * to unsuffixed region-declared names and every region pin was re-pinned: each region's canonical
 * text from the reviewed M1 build (whose raw text matched the earlier pins) equals the canonical
 * text of a clean HEAD build, byte for byte. */
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
      "ec03d4598f986fdbd8334983eb9e94dc4a1c7c1eb9a117238e87201754a84a7a",
      "Locates the Copilot SDK platform runtime package beside the graph's @github/copilot-sdk; npm-shim fallback is Windows-only.",
    ),
    loader(
      "src/provider/Layers/Copilot/Adapter.types.cli.ts",
      "7be5270815a8f795f859f50d8186cd4682eab854e5b7c1ef5f42c4e8a44fb75b",
      "Resolves the optional standalone @github/copilot CLI; absent from the graph, so the caught failure falls back to the SDK runtime.",
    ),
    loader(
      "src/provider/Layers/Pi/Cli.ts",
      "3de5ba64a1634b576301f2b81cc9e8db761b294c0827d9bdd9d88d84a3e56f29",
      "Finds the bundled Pi CLI beside its rpc-entry export and spawns it with the graph's private Node.",
      ["node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"],
    ),
    // Inlined third-party regions of the server bundle.
    loader(
      "msgpackr/unpack.js",
      "6e04f456e946c7b0f2bb03e24a05c43270c454337ce4adfec072ceab9c0841d9",
      "msgpackr record readers generated from decoded field names; generates object literals, loads no modules.",
    ),
    loader(
      "msgpackr/struct.js",
      "7a42dcade49cb3e2dae338624b5f5467d6f93633abfc3ae10c158ff6204304e3",
      "msgpackr struct accessor code generation and a CSP probe; loads no modules.",
    ),
    loader(
      "node-gyp-build-optional-packages/node-gyp-build.js",
      "51baa13c384a4b2cf5ba0ba3614c4907c086e02e1ea3eb645d37e278c8507805",
      "msgpackr's optional msgpackr-extract native lookup; the package is absent and msgpackr falls back to JavaScript.",
    ),
    loader(
      "@anthropic-ai/claude-agent-sdk/sdk.mjs",
      "c822c89d016d3b4a8f2b0c2b18d7eaf33f665ee43d4e09fa7c582764f064123d",
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
