import { describe, expect, it } from "vitest";
import { decodeFramePayload } from "./remoteAgentProtocol.codec.decode.ts";
import { WireWriter } from "./remoteAgentProtocol.codec.wire.ts";

describe("retired terminal backend protocol", () => {
  it.each([58, 59])("does not dispatch retired payload field %s", (field) => {
    const writer = new WireWriter();
    writer.fieldBytes(field, new Uint8Array([10, 1, 114]));
    expect(() => decodeFramePayload(writer.finish())).toThrow("no known payload");
  });
});
