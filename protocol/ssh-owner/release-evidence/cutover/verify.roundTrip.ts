import { readFile } from "node:fs/promises";
import { checkRoundTrip } from "./check.roundTrip.ts";

async function main(args: string[]) {
  if (args.length !== 2) {
    throw new Error("Usage: bun run verify.roundTrip.ts <matrix-plan.json> <round-trip.json>");
  }
  const [matrix, evidence] = await Promise.all(
    args.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown),
  );
  console.log(JSON.stringify(checkRoundTrip(matrix, evidence), null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid cutover round-trip evidence");
  process.exitCode = 1;
}
