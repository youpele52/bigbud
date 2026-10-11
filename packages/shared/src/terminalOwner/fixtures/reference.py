"""Independent stdlib-only prototype v1.1 C/HMAC vectors; no TS imports or wire codec."""
import hashlib
import hmac
import json
import pathlib
import struct
import sys


def u8(v):
    return struct.pack(">B", v)


def u16(v):
    return struct.pack(">H", v)


def u32(v):
    return struct.pack(">I", v)


def u64(v):
    return struct.pack(">Q", int(v))


def blob(v):
    return u32(len(v)) + v


def text(v):
    return blob(v.encode("utf-8"))


def digest(domain, *parts):
    return hashlib.sha256(text(domain) + b"".join(parts)).digest()


def mac(key, domain, *parts):
    return hmac.new(key, text(domain) + b"".join(parts), hashlib.sha256).digest()


def record(name, value):
    # Handwritten field/type inventory, independent from TypeScript layouts.
    layouts = {
        "ProcessIdentity": "os:e pid:q birth:b ownerEpoch:h",
        "RootOp": "sequence:q attemptId:h expectedAuthorityRevision:q",
        "RootIntent": "mode:e use:e op:RootOp expectedMainGeneration:q expectedMainSession:h subject:ProcessIdentity handoverTicket:h",
        "Generations": "main:q controller:q host:q",
        "DirectoryIdentity": "os:e volume:b fileId:b path:b",
        "ProfileIdentity": "identityVersion:v os:e user:b channel:s namespace:e backend:DirectoryIdentity userData:DirectoryIdentity",
        "PtyScopeEntry": "ownerEpoch:h ptyId:h terminalGeneration:q capabilities:e[]",
        "Scope": "role:e use:e revision:q generations:Generations process:ProcessIdentity artifactSetDigest:h createBudget:i capabilities:e[] ptys:PtyScopeEntry[] shutdownId:h cleanupInventory:ShutdownInventoryBinding?",
        "ShutdownInventoryBinding": "version:v inventoryId:h ownerEpoch:h shutdownId:h parentRootSequence:q inventoryCut:h",
        "ShutdownPtyReservation": "slot:i ptyId:h terminalGeneration:q resourceIdentity:h",
        "OwnerShutdownInventory": "binding:ShutdownInventoryBinding ptys:ShutdownPtyReservation[]",
        "CleanupGrantResult": "outcome:CleanupOutcome grantId:h secret:h scope:Scope scopeDigest:h ttlMs:q",
        "Limit": "key:i value:q", "Limits": "entries:Limit[]",
        "ReplacementBinding": "replacementId:h oldGrantId:h oldScopeRevision:q oldSession:h",
        "LaneBinding": "ticketId:h serial:q ownerEpoch:h endpointInstance:h parentSession:h parentTranscript:h role:e scopeDigest:h scopeRevision:q generations:Generations lane:e ttlMs:q",
        "ClientHello": "major:v minorMin:v minorMax:v profileDigest:h artifactSetDigest:h ownerEpoch:h endpointInstance:h role:e kind:e credentialId:h lane:e clientNonce:h rootIntent:RootIntent? replacement:ReplacementBinding? laneBinding:LaneBinding?",
        "ChallengeFields": "major:v minor:v profile:ProfileIdentity artifactSetDigest:h ownerEpoch:h endpointInstance:h role:e kind:e credentialId:h lane:e clientNonce:h ownerNonce:h handshakeId:h proposedSession:h laneId:h authorityRevision:q generations:Generations ttlRemainingMs:q rootIntent:RootIntent? scope:Scope? scopeDigest:h limits:Limits limitsDigest:h replacement:ReplacementBinding? laneBinding:LaneBinding?",
        "OwnerChallenge": "fields:ChallengeFields ownerProof:h",
        "ClientProof": "handshakeId:h transcript:h clientProof:h",
        "FinishFields": "handshakeId:h transcript:h sessionId:h laneId:h scopeDigest:h limitsDigest:h rootIntentDigest:h",
        "OwnerFinish": "fields:FinishFields finishProof:h",
        "FinishAck": "handshakeId:h sessionId:h finishDigest:h ackProof:h",
        "SessionReady": "sessionId:h transcript:h authorityRevision:q disposition:e",
        "SessionFrameFields": "sessionId:h laneId:h direction:e sequence:q generations:Generations scopeRevision:q kind:i body:b",
        "SessionFrame": "sessionId:h laneId:h direction:e sequence:q generations:Generations scopeRevision:q kind:i body:b mac:h",
        "AuthError": "code:e retryAfterMs:i",
        "RootCommit": "intent:RootIntent candidateSession:h",
        "CleanupRef": "parentRootSequence:q shutdownId:h class:e slot:i resourceIdentity:h",
        "CleanupOutcome": "child:CleanupRef childId:h mutationDigest:h state:e dispositionDigest:h resultCapsuleDigest:h? authorityRevision:q",
    }
    primitives = {"e": u8, "v": u16, "i": u32, "q": u64, "b": blob, "s": text, "h": lambda v: v}

    def operand(type_, item):
        if type_.endswith("[]"):
            return u32(len(item)) + b"".join(operand(type_[:-2], x) for x in item)
        return primitives[type_](item) if type_ in primitives else record(type_, item)

    output = b""
    for field in layouts[name].split():
        key, type_ = field.split(":")
        if type_.endswith("?"):
            output += u8(int(key in value))
            if key not in value:
                continue
            type_ = type_[:-1]
        output += operand(type_, value[key])
    return output


def main():
    id_ = lambda n: bytes([n]) * 32
    zero = id_(0)
    directory = {"os": 1, "volume": u64(3), "fileId": u64(4), "path": b"/synthetic/profile"}
    profile = {"identityVersion": 1, "os": 1, "user": u64(501), "channel": "test-\u00e9", "namespace": 2, "backend": directory, "userData": {**directory, "fileId": u64(5)}}
    process = {"os": 1, "pid": "42", "birth": b"\x02" + u64(100) + u32(200), "ownerEpoch": id_(1)}
    intent = {"mode": 1, "use": 1, "op": {"sequence": "1", "attemptId": id_(6), "expectedAuthorityRevision": "0"}, "expectedMainGeneration": "0", "expectedMainSession": zero, "subject": process, "handoverTicket": zero}
    values = [65536,8192,49152,5000,30000,5000,600000,5000,524288,256,0,0,32768,1,5000,30000,4096,8,32,64,4096,4,300000,30000]
    limits = {"entries": [{"key": i + 1, "value": str(v)} for i, v in enumerate(values)]}
    pd = digest("profile/v1", record("ProfileIdentity", profile))
    ld = digest("limits/v1", record("Limits", limits))
    hello = {"major": 1, "minorMin": 1, "minorMax": 1, "profileDigest": pd, "artifactSetDigest": id_(2), "ownerEpoch": id_(1), "endpointInstance": id_(3), "role": 1, "kind": 1, "credentialId": zero, "lane": 1, "clientNonce": id_(4), "rootIntent": intent}
    generations = {"main": "0", "controller": "0", "host": "0"}
    fields = {"major": 1, "minor": 1, "profile": profile, "artifactSetDigest": id_(2), "ownerEpoch": id_(1), "endpointInstance": id_(3), "role": 1, "kind": 1, "credentialId": zero, "lane": 1, "clientNonce": id_(4), "ownerNonce": id_(5), "handshakeId": id_(7), "proposedSession": id_(8), "laneId": id_(9), "authorityRevision": "0", "generations": generations, "ttlRemainingMs": "5000", "rootIntent": intent, "scopeDigest": zero, "limits": limits, "limitsDigest": ld}
    key = mac(id_(10), "bigbud/terminal-owner/root-auth/v1", pd, id_(1), id_(2))
    transcript = digest("bigbud/terminal-owner/auth/v1.1", record("ClientHello", hello), record("ChallengeFields", fields))
    finish_fields = {"handshakeId": id_(7), "transcript": transcript, "sessionId": id_(8), "laneId": id_(9), "scopeDigest": zero, "limitsDigest": ld, "rootIntentDigest": digest("root-intent/v1", record("RootIntent", intent))}
    finish = {"fields": finish_fields, "finishProof": mac(key, "owner-finish", record("FinishFields", finish_fields))}
    fd = digest("finish/v1", record("OwnerFinish", finish))
    ack = {"handshakeId": id_(7), "sessionId": id_(8), "finishDigest": fd, "ackProof": mac(key, "finish-ack", id_(7), id_(8), fd)}
    frame = {"sessionId": id_(8), "laneId": id_(9), "direction": 1, "sequence": "18446744073709551615", "generations": generations, "scopeRevision": "0", "kind": 10, "body": b"\x00\xfftest"}
    c2o = mac(key, "session-key/c2o", transcript, id_(8), id_(9))
    records = {"ProfileIdentity": profile, "RootIntent": intent, "ClientHello": hello, "ChallengeFields": fields, "OwnerChallenge": {"fields": fields, "ownerProof": mac(key, "owner-proof", transcript)}, "ClientProof": {"handshakeId": id_(7), "transcript": transcript, "clientProof": mac(key, "client-proof", transcript)}, "OwnerFinish": finish, "FinishAck": ack, "SessionFrameFields": frame}
    scope = {"role": 2, "use": 1, "revision": "1", "generations": {"main": "1", "controller": "1", "host": "0"}, "process": process, "artifactSetDigest": id_(2), "createBudget": 32, "capabilities": [1, 2, 3, 4, 5, 9], "ptys": [{"ownerEpoch": id_(1), "ptyId": id_(11), "terminalGeneration": "1", "capabilities": [1, 2, 3, 4, 5, 9]}], "shutdownId": zero}
    records.update({"ProcessIdentity": process, "RootOp": intent["op"], "Generations": generations, "DirectoryIdentity": directory, "Scope": scope, "PtyScopeEntry": scope["ptys"][0], "Limits": limits, "Limit": limits["entries"][0], "ReplacementBinding": {"replacementId": id_(12), "oldGrantId": id_(13), "oldScopeRevision": "1", "oldSession": id_(14)}, "LaneBinding": {"ticketId": id_(15), "serial": "1", "ownerEpoch": id_(1), "endpointInstance": id_(3), "parentSession": id_(8), "parentTranscript": transcript, "role": 1, "scopeDigest": zero, "scopeRevision": "0", "generations": generations, "lane": 2, "ttlMs": "5000"}, "FinishFields": finish_fields, "SessionReady": {"sessionId": id_(8), "transcript": transcript, "authorityRevision": "0", "disposition": 1}, "SessionFrame": {**frame, "mac": mac(c2o, "frame/v1", record("SessionFrameFields", frame))}, "AuthError": {"code": 1, "retryAfterMs": 1000}, "RootCommit": {"intent": intent, "candidateSession": id_(8)}, "CleanupRef": {"parentRootSequence": "249", "shutdownId": id_(16), "class": 1, "slot": 63, "resourceIdentity": id_(17)}})
    records["CleanupOutcome"] = {"child": records["CleanupRef"], "childId": id_(18), "mutationDigest": id_(19), "state": 4, "dispositionDigest": id_(20), "resultCapsuleDigest": id_(21), "authorityRevision": "256"}
    expected = {"profileDigest": pd.hex(), "limitsDigest": ld.hex(), "rootKey": key.hex(), "transcript": transcript.hex(), "clientToOwner": c2o.hex(), "ownerToClient": mac(key, "session-key/o2c", transcript, id_(8), id_(9)).hex(), "frameTag": mac(c2o, "frame/v1", record("SessionFrameFields", frame)).hex()}
    expected["rootMutation"] = digest("root-mutation/v1", id_(1), u32(10), record("RootCommit", records["RootCommit"])).hex()
    expected["cleanupChildMax"] = digest("cleanup-child/v1", id_(1), id_(241), u8(1), u32(63), id_(65)).hex()
    reservations = [{"slot": i, "ptyId": id_(11 + i), "terminalGeneration": "1", "resourceIdentity": id_(100 + i)} for i in range(64)]
    # Synthetic immutable parent capture, independent of the TS model-only cut recipe.
    inventory_cut = digest("accepted-inventory-fixture/v1", id_(1), id_(12), u64(249), u32(64), *(record("ShutdownPtyReservation", p) for p in reservations))
    binding = {"version": 1, "inventoryId": id_(50), "ownerEpoch": id_(1), "shutdownId": id_(12), "parentRootSequence": "249", "inventoryCut": inventory_cut}
    cleanup_scope = {**scope, "role": 4, "use": 3, "createBudget": 0, "capabilities": [9, 10], "ptys": [], "shutdownId": id_(12), "cleanupInventory": binding}
    scope_digest = digest("scope/v1.1", record("Scope", cleanup_scope))
    cleanup_values = [*values]
    cleanup_values[8:12] = [131072, 128, 0, 0]
    cleanup_limits = {"entries": [{"key": i + 1, "value": str(v)} for i, v in enumerate(cleanup_values)]}
    cleanup_hello = {**hello, "role": 4, "kind": 2, "credentialId": id_(40), "clientNonce": id_(41)}
    del cleanup_hello["rootIntent"]
    cleanup_fields = {**fields, "role": 4, "kind": 2, "credentialId": id_(40), "clientNonce": id_(41), "ownerNonce": id_(42), "handshakeId": id_(43), "proposedSession": id_(44), "laneId": id_(45), "authorityRevision": "248", "generations": cleanup_scope["generations"], "scope": cleanup_scope, "scopeDigest": scope_digest, "limits": cleanup_limits, "limitsDigest": digest("limits/v1", record("Limits", cleanup_limits))}
    del cleanup_fields["rootIntent"]
    cleanup_key = id_(46)
    cleanup_t = digest("bigbud/terminal-owner/auth/v1.1", record("ClientHello", cleanup_hello), record("ChallengeFields", cleanup_fields))
    cleanup_finish_fields = {**finish_fields, "handshakeId": id_(43), "transcript": cleanup_t, "sessionId": id_(44), "laneId": id_(45), "scopeDigest": scope_digest, "limitsDigest": cleanup_fields["limitsDigest"], "rootIntentDigest": zero}
    cleanup_finish = {"fields": cleanup_finish_fields, "finishProof": mac(cleanup_key, "owner-finish", record("FinishFields", cleanup_finish_fields))}
    cleanup_fd = digest("finish/v1", record("OwnerFinish", cleanup_finish))
    cleanup_child = {"parentRootSequence": "249", "shutdownId": id_(12), "class": 3, "slot": 10, "resourceIdentity": inventory_cut}
    cleanup_outcome = {"child": cleanup_child, "childId": digest("cleanup-child/v1", id_(1), id_(12), u8(3), u32(10), inventory_cut), "mutationDigest": digest("synthetic-authorize-shutdown-reconciler/v1", inventory_cut), "state": 2, "dispositionDigest": zero, "authorityRevision": "248"}
    records.update({"ShutdownInventoryBinding": binding, "ShutdownPtyReservation": reservations[0], "OwnerShutdownInventory": {"binding": binding, "ptys": reservations}, "CleanupGrantResult": {"outcome": cleanup_outcome, "grantId": id_(40), "secret": cleanup_key, "scope": cleanup_scope, "scopeDigest": scope_digest, "ttlMs": "30000"}, "CleanupScope": cleanup_scope, "CleanupClientHello": cleanup_hello, "CleanupChallengeFields": cleanup_fields, "CleanupOwnerChallenge": {"fields": cleanup_fields, "ownerProof": mac(cleanup_key, "owner-proof", cleanup_t)}, "CleanupClientProof": {"handshakeId": id_(43), "transcript": cleanup_t, "clientProof": mac(cleanup_key, "client-proof", cleanup_t)}, "CleanupOwnerFinish": cleanup_finish, "CleanupFinishAck": {"handshakeId": id_(43), "sessionId": id_(44), "finishDigest": cleanup_fd, "ackProof": mac(cleanup_key, "finish-ack", id_(43), id_(44), cleanup_fd)}})
    aliases = {"Cleanup" + name: name for name in ["Scope", "ClientHello", "ChallengeFields", "OwnerChallenge", "ClientProof", "OwnerFinish", "FinishAck"]}
    expected.update({"prototypeMinor": "1", "cleanupTranscript": cleanup_t.hex(), "cleanupScopeDigest": scope_digest.hex()})
    directory = pathlib.Path(__file__).with_name("canonical")
    artifacts = {n: {"type": aliases.get(n, n), "input": v, "canonical": record(aliases.get(n, n), v).hex()} for n, v in records.items()}
    artifacts["OwnerShutdownInventory"]["input"] = {"binding": binding, "ptys": {"$reservations": ["inventory.part" + str(i) for i in range(4)]}}
    for i in range(4):
        artifacts["inventory.part" + str(i)] = {"reservations": reservations[i * 16:(i + 1) * 16]}
    artifacts["expected"] = expected
    if "--check" in sys.argv and {p.name for p in directory.glob("*.json")} != {n + ".json" for n in artifacts}:
        raise RuntimeError("synthetic fixture inventory mismatch")
    if "--check" not in sys.argv:
        directory.mkdir(exist_ok=True)
    for name, artifact in artifacts.items():
        result = json.dumps(artifact, default=lambda b: {"$bytes": b.hex()}, indent=2, ensure_ascii=False) + "\n"
        path = directory / (name + ".json")
        if "--check" in sys.argv:
            if json.loads(path.read_text(encoding="utf-8")) != json.loads(result):
                raise RuntimeError("synthetic vector mismatch")
        else:
            path.write_text(result, encoding="utf-8")
    if "--check" in sys.argv:
        print("Independent Python vectors match")


if __name__ == "__main__":
    main()
