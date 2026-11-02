import * as Effect from "effect/Effect";

// Reserve the applied migration ID without creating resources for the retired backend.
// Existing databases may retain its unused table; removal must not erase session data.
export default Effect.void;
