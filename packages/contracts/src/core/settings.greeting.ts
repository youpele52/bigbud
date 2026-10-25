import * as Schema from "effect/Schema";

import { TrimmedString } from "./baseSchemas";

export const GREETING_NAME_MAX_LENGTH = 64;

/** Optional, UI-only nickname shared by clients connected to this server. */
export const GreetingName = TrimmedString.check(Schema.isMaxLength(GREETING_NAME_MAX_LENGTH));
