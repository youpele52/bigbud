import { expect, it } from "vitest";
import { selectV2SharedDatabase } from "./SharedService.storage.files.ts";
import { decodeV2WindowsProcess } from "./SharedService.storage.windows.ts";
import { decodeInspectionHex } from "./SharedService.windows.ts";
const hex = (s: string) => Buffer.from(s).toString("hex");

it("selects extensionless custom storage only from a unique open WAL/SHM pair", () => {
  expect(
    selectV2SharedDatabase([
      "/custom/state",
      "/custom/state-wal",
      "/custom/state-shm",
      "/another.db",
    ]),
  ).toBe("/custom/state");
  expect(selectV2SharedDatabase(["C:\\User Space\\native", "C:\\User Space\\native-shm"])).toBe(
    "C:\\User Space\\native",
  );
  for (const files of [[], ["/guessed/opencode.db"], ["/a", "/a-wal", "/b", "/b-shm"]])
    expect(() => selectV2SharedDatabase(files)).toThrow("Ambiguous");
});

it("retains Windows identifiers losslessly and rejects malformed/ambiguous metadata", () => {
  const id = "ffffffffffffffff:ffffffffffffffffffffffffffffffff";
  const row = `${hex("C:\\Users\\me\\native")},${id},1`;
  const fields = ["0123456789abcdef", hex("C:\\Program Files\\OpenCode\\service.exe"), row];
  expect(decodeV2WindowsProcess(fields).files.get("C:\\Users\\me\\native")).toBe(id);
  expect(() =>
    decodeV2WindowsProcess([fields[0]!, fields[1]!, `${row};${row.replace("f", "0")}`]),
  ).toThrow();
  expect(() => decodeV2WindowsProcess(["pid", fields[1]!, row])).toThrow();
  expect(() => decodeInspectionHex("0g")).toThrow();
  expect(() => decodeInspectionHex("ff")).toThrow();
});
