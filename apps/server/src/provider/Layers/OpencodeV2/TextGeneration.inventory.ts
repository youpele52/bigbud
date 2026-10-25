import type { OpencodeV2Client } from "./Client.ts";
import { v2Request } from "./Client.ts";

/** Unknown older auxiliary sessions retain capacity across backend restart; never adopt or delete them. */
export async function retainedV2TextGenerationSessions(
  client: OpencodeV2Client,
  signal: AbortSignal,
): Promise<ReadonlyArray<string>> {
  let cursor: string | undefined;
  const retained = new Set<string>();
  const cursors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const listing = await v2Request(
      "auxiliary retained inventory",
      (abort) =>
        client.session.list(
          {
            limit: 200,
            ...(cursor ? { cursor } : {}),
          },
          { signal: abort },
        ),
      { signal },
    );
    if (listing.data.length > 200) throw new Error("V2 auxiliary inventory bound exceeded.");
    // Registration-file identities are logical namespaces, not proof of independent physical storage.
    // Count every observed auxiliary job, including aliases and our currently admitted exact IDs.
    for (const session of listing.data)
      if (
        session.metadata?.bigbud_provider === "opencodeV2" &&
        session.metadata.bigbud_workload === "text-generation"
      )
        retained.add(session.id);
    if (!listing.cursor.next) return [...retained];
    cursor = listing.cursor.next;
    if (cursors.has(cursor)) throw new Error("V2 auxiliary inventory cursor rejected.");
    cursors.add(cursor);
  }
  throw new Error("V2 auxiliary retained inventory is incomplete.");
}
