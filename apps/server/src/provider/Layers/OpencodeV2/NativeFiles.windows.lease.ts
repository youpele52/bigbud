import { randomBytes } from "node:crypto";
import { win32 as path } from "node:path";
import { V2WindowsInspector } from "./SharedService.windows.ts";
import { decodeV2WindowsDirectoryIdentity } from "./SharedService.windows.identity.ts";

/** Pin a private backup against replacement/writes while a read-only SQLite snapshot consumes it. */
export async function withV2WindowsReadLease<T>(
  filename: string,
  run: (lease: {
    hash: string;
    assertCurrent: () => void;
    verify: () => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const helper = new V2WindowsInspector(undefined, {
    request: 131070,
    response: 1048577,
    keepAlive: true,
  });
  const token = randomBytes(16).toString("hex");
  try {
    if (!(await helper.request("CAPABILITIES\t1")).includes("read-lease=1"))
      throw new Error("V2 native read-lease capability unavailable.");
    const fields = await helper.request(
      [
        "FS",
        "1",
        "LEASE_OPEN",
        Buffer.from(path.dirname(filename)).toString("hex"),
        Buffer.from(path.basename(filename)).toString("hex"),
        token,
      ].join("\t"),
      () => {},
    );
    if (
      fields.length !== 3 ||
      !/^[a-f0-9]{64}$/.test(fields[1]!) ||
      !/^\d{1,9}$/.test(fields[2]!) ||
      Number(fields[2]) > 536870912
    )
      throw new Error("V2 native read-lease response rejected.");
    decodeV2WindowsDirectoryIdentity([fields[0]!]);
    const assertCurrent = helper.captureConnectionGuard();
    const verify = async () => {
      assertCurrent();
      const result = await helper.request(`FS\t1\tLEASE_CHECK\t${token}`);
      if (result.length) throw new Error("V2 native read-lease verification rejected.");
      assertCurrent();
    };
    const result = await run({ hash: fields[1]!, assertCurrent, verify });
    await verify();
    if ((await helper.request(`FS\t1\tLEASE_CLOSE\t${token}`)).length)
      throw new Error("V2 native read-lease release rejected.");
    return result;
  } finally {
    helper.close();
  }
}
