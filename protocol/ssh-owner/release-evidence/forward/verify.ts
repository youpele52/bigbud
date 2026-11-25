import { readFile } from "node:fs/promises";
import { checkForwardBoundary } from "./check.ts";

async function main(args: string[]) {
  if (args.length !== 2) {
    throw new Error("Usage: bun run verify.ts <forward-plan.json> <boundary-observations.json>");
  }
  const [plan, observations] = await Promise.all(
    args.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown),
  );
  console.log(JSON.stringify(checkForwardBoundary(plan, observations), null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid forward boundary evidence");
  process.exitCode = 1;
}
