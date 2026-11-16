/** Bounded text consumption shared by credential-free identity and narrow pairing responses. */
export async function readMobileResponseText(
  response: Response,
  request: { wait<T>(work: Promise<T>): Promise<T> },
  maxBytes = 16 * 1024,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Backend response is empty.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await request.wait(reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Backend response is too large.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
