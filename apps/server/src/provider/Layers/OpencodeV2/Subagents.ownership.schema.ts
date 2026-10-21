import { Schema } from "effect";
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const Child = Schema.Struct({
  id: Text,
  parentId: Text,
  taskId: Text,
  agent: Text,
  description: Text,
  prompt: Schema.String.check(Schema.isMaxLength(16384)),
  messageId: Text,
  callId: Text,
  background: Schema.Boolean,
  depth: Schema.Number,
  nativeRevision: Schema.optionalKey(Schema.Number),
  observedRevision: Schema.optionalKey(Schema.Number),
  executionReceipt: Schema.optionalKey(Text),
  executionReceipts: Schema.optionalKey(Schema.Array(Text)),
  executionPending: Schema.optionalKey(Schema.Boolean),
  continuationPending: Schema.optionalKey(Schema.Boolean),
  nativeCompletion: Schema.optionalKey(Text),
  generation: Schema.optionalKey(Schema.Int),
  admissionId: Schema.optionalKey(Text),
  turnId: Schema.optionalKey(Text),
  state: Schema.Literals(["enrolled", "uncertain", "terminal"]),
});
export type V2OwnedChild = typeof Child.Type;
export const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  storageIdentity: Text,
  rootId: Text,
  threadId: Text,
  revision: Schema.Number,
  fenced: Schema.Boolean,
  generation: Schema.optionalKey(Schema.Int),
  admission: Schema.optionalKey(Schema.Struct({ id: Text, fingerprint: Text })),
  pendingSpawns: Schema.optionalKey(Schema.Array(Text)),
  children: Schema.Array(Child),
});
export type Snapshot = typeof Snapshot.Type;
