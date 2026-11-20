import { authorizeRemoteClientRequest } from "../remote-backend/clientAuthorization.ts";

/** The private relay replaces its local query credential with the backend's Bearer header. */
export function authorizeWebsocketRpcConnection(input: {
  readonly mode: string;
  readonly authToken: string | undefined;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): "authorized" | "unauthorized" | "incompatible" | "invalid-url" {
  if (input.mode === "remote")
    return authorizeRemoteClientRequest({
      method: "GET",
      url: input.url,
      headers: input.headers,
      expectedToken: input.authToken,
    });
  if (!input.authToken) return "authorized";
  try {
    return new URL(input.url, "http://localhost").searchParams.get("token") === input.authToken
      ? "authorized"
      : "unauthorized";
  } catch {
    return "invalid-url";
  }
}
