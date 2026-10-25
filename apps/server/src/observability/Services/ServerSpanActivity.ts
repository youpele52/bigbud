import { ServiceMap } from "effect";

import type { SpanActivityShape } from "../SpanActivity.ts";

/** Span activity recorded by the local file tracer; absent when no tracer is installed. */
export class ServerSpanActivity extends ServiceMap.Service<ServerSpanActivity, SpanActivityShape>()(
  "bigbud/observability/Services/ServerSpanActivity",
) {}
