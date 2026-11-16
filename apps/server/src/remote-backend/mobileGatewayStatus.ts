import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { RemoteMobileAdmissionStamp } from "../mobile/Services/MobileRemoteControlAdmission.ts";
export type { RemoteMobileAdmissionStamp } from "../mobile/Services/MobileRemoteControlAdmission.ts";

/** Supplied only by a real identity-checked gateway lifecycle owner, never by socket binding. */
export class RemoteMobileGatewayStatus extends ServiceMap.Service<
  RemoteMobileGatewayStatus,
  {
    readonly ready: Effect.Effect<boolean>;
    /** Canonical external origin from the same verified lifecycle configuration. */
    readonly verifiedExternalOrigin?: string | undefined;
    /** Fresh committed consent/current identity/origin and real owned-child readiness. */
    readonly readAdmission?: () => Effect.Effect<RemoteMobileAdmissionStamp | null, Error>;
    /** Subscribe before rereading: changed pin/revision/origin revokes; lost readiness disables. */
    readonly watchAdmissionEnd?: (
      stamp: RemoteMobileAdmissionStamp,
    ) => Effect.Effect<"revoked" | "disabled", Error>;
  }
>()("bigbud/remote-backend/MobileGatewayStatus") {}
