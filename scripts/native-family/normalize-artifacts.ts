import path from "node:path";
import { normalizeNativeFamilyArtifacts } from "./export-source-patch.artifacts.ts";

// Deliberately separate from the source exporter: never interpret a mode flag as
// an external checkout, and never read native sources or launch native tooling.
if (process.argv.length !== 2) throw new Error("Repo-only normalization takes no arguments.");
const changed = await normalizeNativeFamilyArtifacts(path.resolve(import.meta.dirname, "../.."));
console.log(`Normalized native family banners: ${changed.join(", ") || "already portable"}`);
