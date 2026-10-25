import { readFile } from "node:fs/promises";
import { prepareV2NativeQualificationRecord } from "../src/provider/Layers/OpencodeV2/NativeCompatibility.evidence.ts";

const input = process.argv[2];
if (!input)
  throw new Error(
    "Supply a frozen approved native evidence packet. No native executable, API or runtime registry is accessed.",
  );
const source = await readFile(input, "utf8");
if (Buffer.byteLength(source) > 1048576) throw new Error("Qualification evidence byte bound.");
const record = prepareV2NativeQualificationRecord(JSON.parse(source));
if (process.argv.includes("--check"))
  console.log(
    "Completed qualification evidence structure/identity verified; runtime registry unchanged.",
  );
else console.log(JSON.stringify(record, null, 2));
