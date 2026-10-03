# Native Lifecycle Event Store Foundation

Date: 1 October 2026; Status: Accepted bounded implementation, review pending.

Parent STATIC0015 approved frontier/queued receipts no defects/P3 addressed; NOT
execution rerun107tests/23oracles. Crypto dossier credible but NOT approved: proposed
getrandom0.3.4 defaultfalse,sha20.10.9 defaultfalseforce-soft,base640.22.1
defaultfalsealloc remain unauthorized. No implicit reuse permission; no crypto added.
Independent canonical storage continues rather than stopping at crypto-path gate.

Port ten simple lifecycle event codecs and real transactional append/read/command/
replay repository foundation. Source canonical sequencing includes prefix/events/
gaps, permanent ID reservation, streamstate0then+1, marker mainentity+threadIds on
deletion. Source append doesn't consume receipts, claims or consent; preserve this
separation. Does not authorize commandexecution/exclusiveclaimed retry, deletion
side effects, retention/compaction, clientmutationRPC or providers.

Typed canonical constructor trims brandedIDs, strips unknown fields, requires null
envelopefields; timestamp schema is String not ISO validator. Known variants only;
unknowns fail closed including reads, no event skipping or pretending full codecs.
Encoded event16KiB,IDs4096byte,page100/cursor safeJSinteger limits explicit preview
deviations. Source malformed typed-cast append may commit before full eventdecode;
this trusted bounded interface prevalidates and decodes within transaction, refusing
unsafe malformed commit rather than emulating it. No existing historical importer.

Actual source codec/service/SQL fixtures and realSQLite transaction rollback/fault/
ownership/restart tests required; orderedchecks then independentreview. Authoring
<=400/newapproveddepsonly/originaldecision-dirwrites/no publication all retained.

Source invariant additionally established from actualfinal-schema triggers:
deletion-requested appends create inert direct_resource_cleanup_intents using
commandCLAIM digest/version (not acceptedreceipt), fallbacklegacy markers;
nullcommand makes trigger NOTNULLfail and entireappendrollsback. Existing triggers
remain unchanged and are captured alongside event/ID/stream/marker/receipt tables.
No cleanup executor/authorization added; intent persistence never impliesconsent.
Commandread source LIMIT100 returnsfirst100 at101, not an inventedoverflowerror.
Additional decode-inside-transaction refusal on corrupt storedrow is deliberate
safety deviation from source malformed typed-cast commit-before-full-decode.
