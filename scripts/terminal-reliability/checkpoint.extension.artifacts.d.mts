import type { CheckpointTestFixture } from "./checkpoint.extension.test-fixture.mjs";
export const inputs: { headless: string; browser: string };
export const sourceNames: string[];
export function hash(source: string | Uint8Array): string;
export function sourceManifest(): { name: string; sha256: string }[];
export function buildHash(
  sources: { name: string; sha256: string }[],
  toolchain: CheckpointTestFixture["toolchain"],
): string;
export function verifyArtifacts(directory: string): Promise<{
  schema: number;
  exactCapability: false;
  build: string;
  bundler: string;
  toolchain: CheckpointTestFixture["toolchain"];
  sources: { name: string; sha256: string }[];
  inputs: typeof inputs;
  outputs: typeof inputs;
}>;
