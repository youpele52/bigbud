import * as Identity from "@bigbud/contracts/terminal-owner/identity";
import * as Shutdown from "@bigbud/contracts/terminal-owner/shutdown";

// Numeric field order from security contract §7.3a, not object/protobuf order.
export const identityLayouts = {
  ShutdownInventoryBinding: [
    ["version", "V"],
    ["inventoryId", "ID"],
    ["ownerEpoch", "ID"],
    ["shutdownId", "ID"],
    ["parentRootSequence", "U64"],
    ["inventoryCut", "ID"],
  ],
  ShutdownPtyReservation: [
    ["slot", "U32"],
    ["ptyId", "ID"],
    ["terminalGeneration", "U64"],
    ["resourceIdentity", "ID"],
  ],
  OwnerShutdownInventory: [
    ["binding", "ShutdownInventoryBinding"],
    ["ptys", "ShutdownPtyReservation[]"],
  ],
  ProcessIdentity: [
    ["os", "OS"],
    ["pid", "U64"],
    ["birth", "B"],
    ["ownerEpoch", "ID"],
  ],
  RootOp: [
    ["sequence", "U64"],
    ["attemptId", "ID"],
    ["expectedAuthorityRevision", "U64"],
  ],
  RootIntent: [
    ["mode", "RootMode"],
    ["use", "RootUse"],
    ["op", "RootOp"],
    ["expectedMainGeneration", "U64"],
    ["expectedMainSession", "ID"],
    ["subject", "ProcessIdentity"],
    ["handoverTicket", "ID"],
  ],
  Generations: [
    ["main", "U64"],
    ["controller", "U64"],
    ["host", "U64"],
  ],
  DirectoryIdentity: [
    ["os", "OS"],
    ["volume", "B"],
    ["fileId", "B"],
    ["path", "B"],
  ],
  ProfileIdentity: [
    ["identityVersion", "V"],
    ["os", "OS"],
    ["user", "B"],
    ["channel", "S"],
    ["namespace", "E"],
    ["backend", "DirectoryIdentity"],
    ["userData", "DirectoryIdentity"],
  ],
  PtyScopeEntry: [
    ["ownerEpoch", "ID"],
    ["ptyId", "ID"],
    ["terminalGeneration", "U64"],
    ["capabilities", "E[]"],
  ],
  Scope: [
    ["role", "Role"],
    ["use", "GrantUse"],
    ["revision", "U64"],
    ["generations", "Generations"],
    ["process", "ProcessIdentity"],
    ["artifactSetDigest", "ID"],
    ["createBudget", "U32"],
    ["capabilities", "E[]"],
    ["ptys", "PtyScopeEntry[]"],
    ["shutdownId", "ID"],
    ["cleanupInventory", "ShutdownInventoryBinding?"],
  ],
  Limit: [
    ["key", "U32"],
    ["value", "U64"],
  ],
  Limits: [["entries", "Limit[]"]],
  ReplacementBinding: [
    ["replacementId", "ID"],
    ["oldGrantId", "ID"],
    ["oldScopeRevision", "U64"],
    ["oldSession", "ID"],
  ],
  LaneBinding: [
    ["ticketId", "ID"],
    ["serial", "U64"],
    ["ownerEpoch", "ID"],
    ["endpointInstance", "ID"],
    ["parentSession", "ID"],
    ["parentTranscript", "ID"],
    ["role", "Role"],
    ["scopeDigest", "ID"],
    ["scopeRevision", "U64"],
    ["generations", "Generations"],
    ["lane", "Lane"],
    ["ttlMs", "U64"],
  ],
} as const;
export const identitySchemas = { ...Identity, ...Shutdown };
