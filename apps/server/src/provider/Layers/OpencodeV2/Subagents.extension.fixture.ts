import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { V2RuntimeHttpFixture } from "./Runtime.fixture.ts";
import type { V2FamilyReceipt, V2FamilyEvidence } from "./Subagents.extension.ts";

type Ticket = Omit<
  V2FamilyReceipt,
  "abi" | "childID" | "notificationID" | "jobGeneration" | "status"
>;
type Evidence = typeof V2FamilyEvidence.Type;
interface Ledger {
  register(owner: string, root: string, generation: number, input: string): Promise<Evidence>;
  inspect(owner: string, root: string, generation: number): Promise<Evidence>;
  receipt(owner: string, root: string, generation: number, input: string): Promise<V2FamilyReceipt>;
  begin(
    parent: string,
    message: string,
    call: string,
    continuation?: string,
  ): Promise<Ticket | undefined>;
  enroll(ticket: Ticket, child: string): Promise<void>;
  job(
    ticket: Ticket,
    run: () => Promise<{ started_at: number; notificationID: string }>,
  ): Promise<unknown>;
  finish(ticket: Ticket): Promise<void>;
  acknowledge(ticket: Ticket, notificationID: string): Promise<void>;
  deliver(
    ticket: Ticket,
    child: string,
    notification: string,
    status: "completed",
    admit: (receipt: V2FamilyReceipt, guard: () => void) => Promise<void>,
    wake: () => Promise<void>,
  ): Promise<void>;
  stop(
    owner: string,
    root: string,
    generation: number,
    drain: {
      cancel(children: readonly string[], notifications: readonly string[]): Promise<void>;
      drained(children: readonly string[], notifications: readonly string[]): Promise<boolean>;
    },
  ): Promise<Evidence>;
}

/** Executes the compiled PURE native source ledger, not an OpenCode host/server.
 * HTTP/model/job effects are scripted. This is source-unit evidence only. */
export async function makeV2NativeFamilySourceFixture(http: V2RuntimeHttpFixture, ownerID: string) {
  const directory = new URL(
    "../../../../../../patches/opencode-native-family-v1/",
    import.meta.url,
  );
  const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8")) as {
    sourceDigest: string;
    ledgerSha256: string;
    modules: Record<string, string>;
  };
  const filename = fileURLToPath(new URL("ledger.mjs", directory));
  for (const [name, digest] of Object.entries(manifest.modules)) {
    if (
      !/^[a-z.-]+\.mjs$/.test(name) ||
      createHash("sha256")
        .update(await readFile(new URL(name, directory)))
        .digest("hex") !== digest
    )
      throw new Error("Native family scripted source module changed.");
  }
  if (
    createHash("sha256")
      .update(await readFile(filename))
      .digest("hex") !== manifest.ledgerSha256
  )
    throw new Error("Native family scripted source artifact changed.");
  const module = (await import(pathToFileURL(filename).href)) as {
    Ledger: new (store: unknown, parent: (id: string) => Promise<string | undefined>) => Ledger;
  };
  const values = new Map<string, unknown>();
  type Body = { text: string; description?: string; metadata?: Record<string, unknown> };
  const receipts = (await import(new URL("family.receipt.mjs", directory).href)) as {
    payloadDigest: (body: Body) => string;
    verifyPayload: (binding: unknown, receipt: V2FamilyReceipt, body: Body | undefined) => void;
  };
  const ledger = new module.Ledger(
    {
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => {
        values.set(key, structuredClone(value));
      },
    },
    async (id) => http.sessions.get(id)?.parentID,
  );
  const jobs = new Map<string, { ticket: Ticket; notificationID: string }>();
  const domain = {
    abi: "opencode.native-family.v1",
    sourceDigest: manifest.sourceDigest,
    register: (input: { rootID: string; generation: number; inputID: string }) =>
      ledger.register(ownerID, input.rootID, input.generation, input.inputID),
    inspect: (input: { rootID: string; generation: number }) =>
      ledger.inspect(ownerID, input.rootID, input.generation),
    receipt: async (input: { rootID: string; generation: number; inputID: string }) => {
      const proof = await ledger.receipt(ownerID, input.rootID, input.generation, input.inputID);
      const message = http.messages
        .get(proof.parentID)
        ?.find((message) => message.id === input.inputID);
      receipts.verifyPayload(
        values.get(`native-family.v1/reserved/${input.inputID}`),
        proof,
        message?.type === "synthetic" ? message : undefined,
      );
      return proof;
    },
    stop: (input: { rootID: string; generation: number }) =>
      ledger.stop(ownerID, input.rootID, input.generation, {
        cancel: async (children) => {
          for (const id of [input.rootID, ...children]) {
            await http.client.session.interrupt({ sessionID: id, resume: false });
            http.inbox.set(id, []);
            http.permissions.set(id, []);
            http.forms.set(id, []);
            const native = http.sessions.get(id)!;
            http.sessions.set(id, {
              ...native,
              outcome: "interrupted",
              time: { ...native.time, updated: Date.now(), idle: Date.now() + 1 },
            });
          }
        },
        drained: async (children) =>
          [input.rootID, ...children].every(
            (id) => !http.inbox.get(id)?.length && !http.permissions.get(id)?.length,
          ),
      }),
  };
  return {
    domain,
    ledger,
    sourceDigest: manifest.sourceDigest,
    begin: (parent: string, message: string, call: string, continuation?: string) =>
      ledger.begin(parent, message, call, continuation),
    created: (ticket: Ticket | undefined, child: string) =>
      ticket ? ledger.enroll(ticket, child) : Promise.resolve(),
    started: async (ticket: Ticket | undefined, child: string, background: boolean) => {
      if (!ticket) return;
      const notificationID = `msg_native_notification_${ticket.operationID.replaceAll("-", "_")}`;
      await ledger.job(ticket, async () => ({ started_at: Date.now(), notificationID }));
      jobs.set(child, { ticket, notificationID });
      if (!background) await ledger.finish(ticket);
    },
    complete: async (child: string) => {
      const job = jobs.get(child);
      if (!job) throw new Error("Unknown scripted native job.");
      await ledger.deliver(
        job.ticket,
        child,
        job.notificationID,
        "completed",
        async (receipt, guard) => {
          const messages = http.messages.get(receipt.parentID)!;
          const stamp = values.get(`native-family.v1/origin/${receipt.notificationID}`);
          if (
            messages.some((message) => message.id === receipt.notificationID) &&
            JSON.stringify(stamp) !== JSON.stringify(receipt)
          )
            throw new Error("Scripted atomic native admission collision.");
          guard();
          if (!stamp) {
            // One scripted atomic transaction: native-private origin plus inbox/history admission.
            values.set(
              `native-family.v1/origin/${receipt.notificationID}`,
              structuredClone(receipt),
            );
            messages.push({
              id: receipt.notificationID,
              type: "synthetic",
              text: "native child completed",
              time: { created: Date.now() },
              metadata: { source: "subagent", childID: child, state: "completed" },
            });
            values.set(`native-family.v1/reserved/${receipt.notificationID}`, {
              operationID: receipt.operationID,
              sessionID: receipt.parentID,
              digest: receipts.payloadDigest({
                text: "native child completed",
                metadata: { source: "subagent", childID: child, state: "completed" },
              }),
            });
          }
        },
        async () => {},
      );
      await ledger.acknowledge(job.ticket, job.notificationID);
      const native = http.sessions.get(child)!;
      http.sessions.set(child, {
        ...native,
        outcome: "succeeded",
        time: { ...native.time, updated: Date.now(), idle: Date.now() + 1 },
      });
      return job.notificationID;
    },
    consume: (inputID: string) => {
      const proof = values.get(`native-family.v1/origin/${inputID}`);
      if (!proof) throw new Error("Only a native admission can be consumed.");
      values.set(`native-family.v1/consumed/${inputID}`, structuredClone(proof));
    },
  };
}
export type V2NativeFamilySourceFixture = Awaited<
  ReturnType<typeof makeV2NativeFamilySourceFixture>
>;
