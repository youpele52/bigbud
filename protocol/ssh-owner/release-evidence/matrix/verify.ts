import { readFile } from "node:fs/promises";
import { checkMatrix } from "./check.ts";

async function main(args: string[]) {
  if (args.length !== 2) {
    throw new Error("Usage: bun run verify.ts <matrix-plan.json> <claim-references.json>");
  }
  const [plan, claims] = await Promise.all(
    args.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown),
  );
  console.log(JSON.stringify(checkMatrix(plan, claims), null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid matrix inputs");
  process.exitCode = 1;
}
