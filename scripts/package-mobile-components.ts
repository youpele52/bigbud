import { parseArgs } from "node:util";
import type { MobileGatewayTarget } from "@bigbud/contracts/server/mobileOptionalArtifact";
import { packageMobileComponents } from "./package-mobile-components.producer.ts";

const options = {
  "gateway-binary": { type: "string" },
  target: { type: "string" },
  "assets-directory": { type: "string" },
  "agent-version": { type: "string" },
  "backend-version": { type: "string" },
  "gateway-version": { type: "string" },
  "asset-version": { type: "string" },
  "minimum-mobile-rpc": { type: "string" },
  "maximum-mobile-rpc": { type: "string" },
  "artifact-base-url": { type: "string" },
  "key-id": { type: "string" },
  "key-file": { type: "string" },
  "output-directory": { type: "string" },
  help: { type: "boolean" },
} as const;

try {
  const { values } = parseArgs({ options, strict: true, allowPositionals: false });
  if (values.help) {
    console.log(
      "Build unpublished signed optional mobile gateway/assets artifacts. Never installs or enables a host.",
    );
    console.log(
      "Required options: " +
        Object.keys(options)
          .filter((key) => key !== "help")
          .map((key) => `--${key} <value>`)
          .join(" "),
    );
  } else {
    const required = (name: Exclude<keyof typeof options, "help">): string => {
      const value = values[name];
      if (!value) throw new Error(`Missing required --${name}.`);
      return value;
    };
    const revision = (name: "minimum-mobile-rpc" | "maximum-mobile-rpc"): number => {
      const value = required(name);
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`--${name} must be a positive safe integer.`);
      }
      return Number(value);
    };
    await packageMobileComponents({
      gatewayBinary: required("gateway-binary"),
      targetTriple: required("target") as MobileGatewayTarget,
      assetsDirectory: required("assets-directory"),
      compatibility: {
        agentVersion: required("agent-version"),
        backendVersion: required("backend-version"),
        gatewayVersion: required("gateway-version"),
        mobileAssetVersion: required("asset-version"),
        minimumMobileRpcRevision: revision("minimum-mobile-rpc"),
        maximumMobileRpcRevision: revision("maximum-mobile-rpc"),
      },
      artifactBaseUrl: required("artifact-base-url"),
      keyId: required("key-id"),
      keyFile: required("key-file"),
      outputDirectory: required("output-directory"),
    });
    console.log(
      "Created unpublished signed mobile component artifacts. Host activation requires separate consent and lifecycle validation.",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Mobile component packaging failed.");
  process.exitCode = 1;
}
