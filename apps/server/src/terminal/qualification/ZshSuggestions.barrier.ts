/** Qualification-only controller model. Not wired into production input or transport.
 * No clock relationship / D_safe is assumed: only a matched invalidation ACK can
 * release bytes. A UI timeout reports blockage and NEVER grants a release permit.
 */
export function makeQualificationInputBarrier(input: {
  readonly session: string;
  readonly lease: string;
  readonly sequence: number;
  readonly write: (bytes: string) => void;
}) {
  if (
    !/^[a-zA-Z0-9-]{1,128}$/.test(input.session) ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(input.lease) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 1 ||
    input.sequence > 999999
  )
    throw new Error("Invalid qualification barrier identity.");
  let state: "pending" | "blocked" | "released" | "failed" = "pending";
  let frame = "";
  let queued: string[] = [];
  let bytes = 0;
  let draining = false;
  return {
    get state() {
      return state;
    },
    enqueue(data: string) {
      if (state === "failed")
        throw new Error("Qualification input outcome is unknown; retry is forbidden.");
      // Empty events carry no bytes; retaining them would evade the byte-capacity bound.
      if (data.length === 0) return;
      if (state === "released" && !draining) {
        try {
          input.write(data);
        } catch (error) {
          state = "failed";
          throw error;
        }
        return;
      }
      if (bytes + Buffer.byteLength(data) > 4096) {
        state = "failed";
        queued = [];
        throw new Error("Qualification input barrier capacity exceeded; no input released.");
      }
      queued.push(data);
      bytes += Buffer.byteLength(data);
    },
    timeout() {
      if (state === "pending") state = "blocked";
    },
    status(chunk: string) {
      if (state === "released" || state === "failed") return;
      if (Buffer.byteLength(frame) + Buffer.byteLength(chunk) > 512) {
        state = "failed";
        queued = [];
        frame = "";
        return;
      }
      frame += chunk;
      while (frame.includes("\n")) {
        const end = frame.indexOf("\n");
        const line = frame.slice(0, end);
        frame = frame.slice(end + 1);
        const fields = line.split(" ");
        if (
          fields.length !== 6 ||
          fields[0] !== "v1" ||
          fields[1] !== input.session ||
          fields[2] !== input.lease ||
          fields[3] !== String(input.sequence) ||
          fields[4] !== "suspended" ||
          !/^\d{1,10}$/.test(fields[5]!)
        )
          continue;
        // Consume each entry BEFORE writing. Reentrant input joins the tail rather
        // than overtaking held bytes; a duplicate ACK cannot replay a partial drain.
        state = "released";
        draining = true;
        try {
          while (queued.length > 0) {
            const data = queued.shift()!;
            bytes -= Buffer.byteLength(data);
            input.write(data);
          }
        } catch (error) {
          state = "failed";
          queued = [];
          bytes = 0;
          throw error;
        } finally {
          draining = false;
        }
        break;
      }
    },
  };
}
