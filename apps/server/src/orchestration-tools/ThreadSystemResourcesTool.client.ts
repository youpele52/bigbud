let access: { readonly endpoint: string; readonly token: string } | undefined;
export function setSystemMonitorAgentAccess(next: typeof access): void {
  access = next;
}

/** Fixed loopback routes only; redirects and oversized responses fail closed. */
export async function requestDesktopResources(
  route: "/snapshot" | "/context" | "/read" | "/rules",
  input?: unknown,
): Promise<unknown> {
  const captured = access;
  if (!captured) throw new Error("desktop monitor unavailable");
  const url = new URL(captured.endpoint);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/snapshot" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("desktop monitor unavailable");
  url.pathname = route;
  const body = input === undefined ? undefined : JSON.stringify(input);
  if (body && Buffer.byteLength(body) > 16384) throw new Error("monitor request too large");
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    redirect: "error",
    headers: { authorization: `Bearer ${captured.token}`, "content-type": "application/json" },
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(route === "/context" ? 750 : 7000),
  });
  if (Number(response.headers.get("content-length") ?? 0) > 32768 || !response.body)
    throw new Error("monitor response too large");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 32768) throw new Error("monitor response too large");
    chunks.push(chunk);
  }
  if (access !== captured) throw new Error("monitor authorization revoked");
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!response.ok) {
    const reason =
      parsed &&
      typeof parsed === "object" &&
      "reason" in parsed &&
      typeof parsed.reason === "string"
        ? parsed.reason.slice(0, 256)
        : "desktop monitor unavailable";
    throw new Error(reason);
  }
  return parsed;
}
