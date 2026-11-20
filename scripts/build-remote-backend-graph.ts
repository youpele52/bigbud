import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { buildRemoteBackendGraph } from "./build-remote-backend-graph.producer.ts";

export async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      root: { type: "string" },
      version: { type: "string" },
      "build-digest": { type: "string" },
      target: { type: "string" },
      node: { type: "string" },
      entry: { type: "string" },
      "key-file": { type: "string" },
      "key-id": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: build-remote-backend-graph --root <private-graph> --version <version> " +
        "--build-digest <sha256> --target <aarch64-unknown-linux-gnu|x86_64-unknown-linux-gnu> " +
        "--node <relative-node> --entry <relative-entry> --key-file <private-key-file> " +
        "--key-id <release-key-id> --output <fresh-manifest-path>\n" +
        "Signs a caller-staged static graph; unsupported dynamic/native loaders fail closed. " +
        "Does not execute, install, publish, or establish production runtime qualification.",
    );
    return;
  }
  function required(name: Exclude<keyof typeof values, "help">) {
    const value = values[name];
    if (!value) throw new Error(`Required option --${name} is missing.`);
    return value;
  }
  const target = required("target");
  if (target !== "aarch64-unknown-linux-gnu" && target !== "x86_64-unknown-linux-gnu")
    throw new Error("Only Linux GNU targets are supported.");
  await buildRemoteBackendGraph({
    root: required("root"),
    version: required("version"),
    buildDigest: required("build-digest"),
    target,
    node: required("node"),
    entry: required("entry"),
    keyFile: required("key-file"),
    keyId: required("key-id"),
    output: required("output"),
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(() => {
    console.error("Backend executable graph production failed.");
    process.exitCode = 1;
  });
}
