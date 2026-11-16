import {
  LocalNativeInspection as V2WindowsInspector,
  decodeInspectionHex,
} from "../../../remote-agent/localNativeInspection.ts";
export {
  LocalNativeInspection as V2WindowsInspector,
  decodeInspectionHex,
} from "../../../remote-agent/localNativeInspection.ts";

export const v2WindowsInspector = new V2WindowsInspector();

export async function readV2WindowsRegistration(file: string): Promise<Buffer> {
  const result = await v2WindowsInspector.request(`READ\t${Buffer.from(file).toString("hex")}`);
  if (result.length !== 1 || result[0]!.length > 32_768)
    throw new Error("Registration bound exceeded.");
  return Buffer.from(decodeInspectionHex(result[0]!), "utf8");
}
