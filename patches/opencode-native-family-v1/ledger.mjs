import { __export, exports_family_receipt } from "./receipt-shared.mjs";

// packages/core/src/session/family.ledger.ts
var exports_family_ledger = {};
__export(exports_family_ledger, {
  NativeFamilyLedger: () => exports_family_ledger,
  Ledger: () => Ledger,
});
import { randomUUID } from "node:crypto";
var abi = "opencode.native-family.v1";

class Ledger {
  store;
  parent;
  queues = new Map();
  fences = new Map();
  failures = new Set();
  cached = new Map();
  constructor(store, parent) {
    this.store = store;
    this.parent = parent;
  }
  key(root) {
    return `native-family.v1/root/${root}`;
  }
  async load(root) {
    const value = await this.store.get(this.key(root));
    if (value && (value.abi !== abi || value.rootID !== root || value.operations.length > 128))
      throw new Error("Native family journal rejected");
    const cached = this.cached.get(root);
    if (value && (await this.store.get(`native-family.v1/shell-fault/${root}/${value.generation}`)))
      this.failures.add(root);
    if (!value && cached) throw new Error("Native family durable root disappeared");
    if (
      value &&
      (!cached ||
        value.generation > cached.generation ||
        (value.generation === cached.generation && (!cached.stopped || value.stopped)))
    )
      this.cached.set(root, structuredClone(value));
    return value ? structuredClone(value) : undefined;
  }
  async save(state) {
    this.cached.set(state.rootID, structuredClone(state));
    try {
      await this.store.put(this.key(state.rootID), state);
    } catch (error) {
      this.fences.set(state.rootID, state.generation);
      this.failures.add(state.rootID);
      throw error;
    }
  }
  serial(root, run) {
    const operation = (this.queues.get(root) ?? Promise.resolve()).catch(() => {}).then(run);
    this.queues.set(root, operation);
    return operation.finally(() => {
      if (this.queues.get(root) === operation) this.queues.delete(root);
    });
  }
  current(state, ticket) {
    if (
      state.stopped ||
      this.fences.get(state.rootID) === state.generation ||
      this.failures.has(state.rootID) ||
      (ticket && (ticket.ownerID !== state.ownerID || ticket.generation !== state.generation))
    )
      throw new Error("Native family generation fenced");
  }
  owned(state, owner, generation) {
    if (!state || state.ownerID !== owner || state.generation !== generation)
      throw new Error("Native family owner rejected");
    return state;
  }
  evidence(state) {
    return exports_family_receipt.evidence(
      state,
      this.fences.get(state.rootID) === state.generation,
      this.failures.has(state.rootID),
    );
  }
  async root(id) {
    return exports_family_receipt.root(this.parent, id);
  }
  async shellAdmission(id) {
    const root = await this.root(id),
      state = await this.load(root);
    if (!state) return;
    this.current(state);
    return async () => {
      this.failures.add(root);
      await this.store.put(`native-family.v1/shell-fault/${root}/${state.generation}`, true);
    };
  }
  async register(owner, root, generation, inputID) {
    if (
      !owner ||
      !inputID ||
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      (await this.root(root)) !== root
    )
      throw new Error("Native family registration rejected");
    return this.serial(root, async () => {
      const previous = await this.load(root);
      if (
        previous &&
        (previous.ownerID !== owner ||
          generation < previous.generation ||
          generation > previous.generation + 1)
      )
        throw new Error("Native family registration changed owner/generation");
      if (previous && generation === previous.generation) {
        this.current(previous);
        previous.inputID = inputID;
        await this.save(previous);
        return this.evidence(previous);
      }
      if (
        previous &&
        (!previous.stopped ||
          !previous.settled ||
          previous.uncertain ||
          previous.inputID === inputID)
      )
        throw new Error("Native family prior generation is not drained");
      if (this.failures.has(root)) throw new Error("Native family persistence uncertain");
      const state = {
        abi,
        rootID: root,
        ownerID: owner,
        generation,
        inputID,
        stopped: false,
        settled: false,
        uncertain: false,
        operations: [],
      };
      this.fences.delete(root);
      await this.save(state);
      return this.evidence(state);
    });
  }
  async inspect(owner, root, generation) {
    return this.serial(root, async () =>
      this.evidence(this.owned(await this.load(root), owner, generation)),
    );
  }
  async sessionIDs(owner, root, generation) {
    return this.serial(root, async () => {
      const state = this.owned(await this.load(root), owner, generation);
      return [
        ...new Set([root, ...state.operations.flatMap((op) => (op.childID ? [op.childID] : []))]),
      ];
    });
  }
  async assertRunnable(id) {
    const state = await this.load(await this.root(id));
    if (state) {
      this.current(state);
      if (id !== state.rootID && !state.operations.some((op) => op.childID === id))
        throw new Error("Native family retired child wake rejected");
    }
  }
  async runnableGuard(id) {
    const root = await this.root(id);
    const state = await this.load(root);
    if (!state)
      return () => {
        if (this.cached.has(root)) throw new Error("Native family installed after unowned wake");
      };
    this.current(state);
    const generation = state.generation;
    return () => {
      const current = this.cached.get(root);
      if (!current || current.generation !== generation)
        throw new Error("Native family stale execution generation");
      this.current(current);
      if (id !== root && !current.operations.some((op) => op.childID === id))
        throw new Error("Native family child wake is not enrolled");
    };
  }
  async begin(parentID, messageID, callID, continuation) {
    if (!(await this.allows(parentID))) throw new Error("Native family parent generation fenced");
    const root = await this.root(parentID);
    return this.serial(root, async () => {
      const state = await this.load(root);
      if (!state) return;
      this.current(state);
      if (
        state.operations.length >= 128 ||
        state.operations.some(
          (op) => op.ticket.callID === callID && op.ticket.messageID === messageID,
        )
      )
        throw new Error("Native family operation replay/capacity rejected");
      if (
        continuation &&
        !state.operations.some(
          (op) => op.childID === continuation && op.ticket.parentID === parentID,
        )
      )
        throw new Error("Native family continuation is not owned");
      const ticket = {
        rootID: root,
        ownerID: state.ownerID,
        generation: state.generation,
        operationID: randomUUID(),
        parentID,
        messageID,
        callID,
      };
      state.operations.push({ ticket, done: false });
      await this.save(state);
      this.current(state);
      return ticket;
    });
  }
  async allows(id) {
    try {
      await this.assertRunnable(id);
      return true;
    } catch {
      return false;
    }
  }
  async managed(id) {
    return Boolean(await this.load(await this.root(id)));
  }
  async retired(ticket) {
    const state = await this.load(ticket.rootID);
    return Boolean(
      state &&
      state.ownerID === ticket.ownerID &&
      (state.generation > ticket.generation ||
        (state.generation === ticket.generation &&
          (state.stopped || this.fences.get(ticket.rootID) === ticket.generation))),
    );
  }
  completionIDs(parentID) {
    return [
      ...new Set(
        [...this.cached.values()].flatMap((state) =>
          state.operations.flatMap((op) =>
            op.ticket.parentID === parentID && op.notificationID ? [op.notificationID] : [],
          ),
        ),
      ),
    ];
  }
  operation(state, ticket) {
    return exports_family_receipt.operation(state, ticket);
  }
  async enroll(ticket, childID) {
    return this.serial(ticket.rootID, async () => {
      const state = this.owned(await this.load(ticket.rootID), ticket.ownerID, ticket.generation);
      const operation = this.operation(state, ticket);
      if (
        (await this.parent(childID)) !== ticket.parentID ||
        (operation.childID && operation.childID !== childID)
      )
        throw new Error("Native family child ancestry changed");
      operation.childID = childID;
      await this.save(state);
      this.current(state, ticket);
    });
  }
  async job(ticket, run) {
    return this.serial(ticket.rootID, async () => {
      const state = this.owned(await this.load(ticket.rootID), ticket.ownerID, ticket.generation);
      this.current(state, ticket);
      const operation = this.operation(state, ticket);
      const result = await run();
      operation.jobGeneration = result.started_at;
      if (result.notificationID) operation.notificationID = result.notificationID;
      await this.save(state);
      this.current(state, ticket);
      return result;
    });
  }
  async finish(ticket) {
    return this.serial(ticket.rootID, async () => {
      const state = this.owned(await this.load(ticket.rootID), ticket.ownerID, ticket.generation);
      this.current(state, ticket);
      this.operation(state, ticket).done = true;
      await this.save(state);
    });
  }
  async deliver(ticket, childID, notificationID, status, admit, wake) {
    return this.serial(ticket.rootID, async () => {
      const state = this.owned(await this.load(ticket.rootID), ticket.ownerID, ticket.generation);
      this.current(state, ticket);
      const operation = this.operation(state, ticket);
      if (
        operation.childID !== childID ||
        operation.notificationID !== notificationID ||
        operation.jobGeneration === undefined
      )
        throw new Error("Native family completion is not the exact job notification");
      const receipt = {
        ...ticket,
        abi,
        childID,
        notificationID,
        jobGeneration: operation.jobGeneration,
        status,
      };
      const guard = () => this.current(state, ticket);
      await admit(receipt, guard);
      guard();
      await this.save(state);
      guard();
      const consumed = await this.store.get(`native-family.v1/consumed/${notificationID}`);
      if (consumed?.operationID !== ticket.operationID) await wake();
      guard();
    });
  }
  async acknowledge(ticket, notificationID) {
    return this.serial(ticket.rootID, async () => {
      const state = this.owned(await this.load(ticket.rootID), ticket.ownerID, ticket.generation);
      this.current(state, ticket);
      const operation = this.operation(state, ticket);
      if (operation.notificationID !== notificationID)
        throw new Error("Native notification acknowledgement changed identity");
      for (const entry of state.operations)
        if (
          entry.childID === operation.childID &&
          entry.jobGeneration === operation.jobGeneration &&
          entry.notificationID === notificationID
        )
          entry.done = true;
      await this.save(state);
    });
  }
  async receipt(owner, root, generation, inputID) {
    return this.serial(root, async () => {
      const state = this.owned(await this.load(root), owner, generation);
      this.current(state);
      return exports_family_receipt.read(state, this.store, inputID);
    });
  }
  async stop(owner, root, generation, drain) {
    const known = await this.load(root).catch(() => {
      this.failures.add(root);
      return this.cached.get(root);
    });
    this.owned(known, owner, generation);
    this.fences.set(root, generation);
    return this.serial(root, async () => {
      const state = this.owned(
        await this.load(root).catch(() => {
          this.failures.add(root);
          return this.cached.get(root);
        }),
        owner,
        generation,
      );
      state.stopped = true;
      state.settled = false;
      let uncertain = this.failures.has(root);
      try {
        await this.save(state);
      } catch {
        uncertain = true;
      }
      const children = [
        ...new Set(state.operations.flatMap((op) => (op.childID ? [op.childID] : []))),
      ];
      const notifications = state.operations.flatMap((op) =>
        op.notificationID ? [op.notificationID] : [],
      );
      try {
        await drain.cancel(children, notifications);
      } catch {
        uncertain = true;
      }
      try {
        if (!(await drain.drained(children, notifications))) uncertain = true;
      } catch {
        uncertain = true;
      }
      uncertain ||= this.failures.has(root);
      uncertain ||= state.operations.some((op) => !op.childID);
      state.uncertain = uncertain;
      state.settled = !uncertain;
      if (!uncertain) for (const operation of state.operations) operation.done = true;
      try {
        await this.save(state);
      } catch {
        state.uncertain = true;
        state.settled = false;
      }
      return this.evidence(state);
    });
  }
}
export { exports_family_ledger as NativeFamilyLedger, Ledger };
