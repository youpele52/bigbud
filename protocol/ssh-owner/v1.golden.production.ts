import { agentControlWireCases } from "./v1.golden.agentControl.ts";
import { credentialWireCases } from "./v1.golden.credential.ts";
import { ownerShutdownWireCases } from "./v1.golden.ownerShutdown.ts";
import type { Message } from "./v1.golden.codec.ts";
import { gitUploadWireCases } from "./v1.golden.gitUpload.ts";
import { peerProductionWireCases } from "./v1.golden.peerProduction.ts";
import { remoteBackendWireCases } from "./v1.golden.remoteBackend.ts";
import { systemStatusWireCases } from "./v1.golden.systemStatus.ts";

/**
 * Production per-target lease goldens (non-`proof_*` verbs), one spread per lane, so
 * `v1.golden.cases.ts` stays within the length limit. Add a new production lane here.
 */
export function productionLeaseWireCases(
  request: (tag: number, body: Message) => Message,
  reply: (tag: number, body: Message) => Message,
): Record<string, Message> {
  return {
    ...gitUploadWireCases(request, reply),
    ...remoteBackendWireCases(request, reply),
    ...peerProductionWireCases(request, reply),
    ...agentControlWireCases(request, reply),
    ...credentialWireCases(request, reply),
    ...systemStatusWireCases(request, reply),
    ...ownerShutdownWireCases(request, reply),
  };
}
