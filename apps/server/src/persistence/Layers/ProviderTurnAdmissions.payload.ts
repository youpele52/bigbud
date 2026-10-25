import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
const compress = promisify(gzip);
const decompress = promisify(gunzip);

/** Compressed results retain the same bounded UTF-8 text and immutable admission identity. */
export async function readAdmissionPayload(
  text: string | null,
  encoding: string,
): Promise<string | null> {
  if (encoding === "plain") return text;
  if (
    encoding !== "gzip" ||
    text === null ||
    text.length > 12_000_000 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text)
  )
    throw new Error("Invalid admission payload encoding.");
  const output = await decompress(Buffer.from(text, "base64"), { maxOutputLength: 8_000_000 });
  const decoded = output.toString("utf8");
  if (decoded.length > 2_000_000 || !output.equals(Buffer.from(decoded)))
    throw new Error("Invalid admission payload bounds/UTF-8.");
  return decoded;
}

export async function compactAdmissionPayload(text: string): Promise<string | undefined> {
  const input = Buffer.from(text);
  if (text.length > 2_000_000 || input.length > 8_000_000)
    throw new Error("Admission payload bounds exceeded.");
  const encoded = (await compress(input)).toString("base64");
  return Buffer.byteLength(encoded) < input.length ? encoded : undefined;
}
