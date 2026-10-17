import type { FormInfo } from "@opencode/client";
import type { OpencodeV2Runtime } from "./Runtime.ts";
import type { V2RuntimeSession } from "./Runtime.types.ts";
import { v2Request } from "./Client.ts";
import { runtimeEventBase } from "./Runtime.projection.ts";
import { v2ReplyGuard } from "./Runtime.replies.ts";

const LIMITATION =
  "OpenCode v2 form cannot be displayed safely in bigbud (unsupported presentation or field bounds). Cancelled without submitting answers. Use a supported form or the native interface.";

/** Discovery holds the session queue; cancellation uses the ordinary reply ownership/quarantine fences. */
export function installV2UnsupportedFormCanceller(
  runtime: OpencodeV2Runtime,
  owner: V2RuntimeSession,
) {
  owner.cancelUnsupportedForm = async (form: FormInfo) => {
    const guard = v2ReplyGuard(runtime.options, runtime.sessions, owner);
    const client = owner.lease.process.client;
    await runtime.mutations.run(
      owner,
      "session.form.cancel",
      (signal) =>
        client.session.form.cancel(
          { sessionID: owner.native.id, formID: form.id, message: LIMITATION },
          { signal },
        ),
      async () => false,
      10000,
      async () => {
        await guard();
        const fresh = await v2Request("session.form.get", (signal) =>
          client.session.form.get({ sessionID: owner.native.id, formID: form.id }, { signal }),
        );
        if (
          fresh.id !== form.id ||
          fresh.sessionID !== owner.native.id ||
          fresh.state.status !== "pending" ||
          JSON.stringify(fresh.fields) !== JSON.stringify(form.fields)
        )
          throw new Error("V2 unsupported form changed before cancellation.");
        // Publish before mutation so a failed sink cannot silently lose the limitation.
        await runtime.emit(owner, {
          ...runtimeEventBase(owner, `unsupported-form:${form.id}`),
          type: "runtime.warning",
          payload: { message: LIMITATION.replace("Cancelled", "Cancelling") },
        });
        return guard();
      },
    );
  };
}
