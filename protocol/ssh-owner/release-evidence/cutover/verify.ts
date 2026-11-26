import { readFile } from "node:fs/promises";
import { checkCutover } from "./check.ts";

async function main(args: string[]) {
  if (args.length !== 2)
    throw new Error("Usage: bun run verify.ts <cutover-plan.json> <process-traces.json>");
  const [plan, traces] = await Promise.all(
    args.map(async (path) => JSON.parse(await readFile(path, "utf8")) as unknown),
  );
  console.log(JSON.stringify(checkCutover(plan, traces), null, 2));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid cutover evidence");
  process.exitCode = 1;
}
