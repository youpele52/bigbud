import { randomUUID } from "node:crypto";

/** Process lifetime, not a provider-session, connection, or renderer lifetime. */
export const serverRunId = randomUUID();
