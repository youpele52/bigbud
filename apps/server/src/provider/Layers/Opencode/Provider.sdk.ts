import type { OpencodeClient, Provider as OpencodeSdkProvider } from "@opencode-ai/sdk/v2";

export type OpencodeProviderRecord = OpencodeSdkProvider;

function stringifyErrorObject(error: Record<string, unknown>): string | null {
  const directMessage = error.message;
  if (typeof directMessage === "string" && directMessage.trim().length > 0) {
    return directMessage;
  }

  const nestedData = error.data;
  if (nestedData && typeof nestedData === "object") {
    const nestedMessage = (nestedData as Record<string, unknown>).message;
    if (typeof nestedMessage === "string" && nestedMessage.trim().length > 0) {
      return nestedMessage;
    }
  }

  const serialized = JSON.stringify(error);
  return serialized === undefined || serialized === "{}" ? null : serialized;
}

export function formatOpencodeSdkError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const formatted = stringifyErrorObject(error as Record<string, unknown>);
    if (formatted) {
      return formatted;
    }
  }

  return String(error);
}

export async function listOpencodeProviders(
  client: OpencodeClient,
): Promise<Array<OpencodeProviderRecord>> {
  const providerListResp = await client.provider.list();
  if (providerListResp.error) {
    const configProvidersResp = await client.config.providers();
    if (configProvidersResp.error) {
      throw new Error(
        `Failed to list OpenCode providers: ${formatOpencodeSdkError(
          providerListResp.error,
        )}; config fallback failed: ${formatOpencodeSdkError(configProvidersResp.error)}`,
      );
    }
    return configProvidersResp.data?.providers ?? [];
  }

  return providerListResp.data?.all ?? [];
}
