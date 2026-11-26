import type { DocumentDownloadTransport } from "./documentUrl.download.ts";

export function documentTransport(
  respond: (url: string) => Response,
  resolve: DocumentDownloadTransport["resolve"] = async () => [{ address: "93.184.216.34" }],
): DocumentDownloadTransport {
  return {
    resolve,
    open: async ({ protocol, headers, path }) => {
      const response = respond(`${protocol}//${(headers as { host: string }).host}${path}`);
      const reader = response.body?.getReader();
      return {
        status: response.status,
        header: (name) => response.headers.get(name) ?? undefined,
        body: (async function* () {
          if (!reader) return;
          for (;;) {
            const next = await reader.read();
            if (next.done) return;
            yield next.value;
          }
        })(),
        dispose: () => void reader?.cancel().catch(() => {}),
      };
    },
  };
}
