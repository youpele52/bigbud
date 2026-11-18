import { RemoteAgentPtyError } from "./remoteAgentPtyClient.types.ts";

interface AttachmentState {
  pid: number;
  revision: number;
  active: boolean;
  recovering: boolean;
}

interface AttachmentOwner {
  signal: AbortSignal;
  state(): AttachmentState;
  retry(): Promise<void>;
  attach(pid: number, signal: AbortSignal): Promise<void>;
  assertInputUsable(): void;
  failed(revision: number, error: Error): void;
}

/** A caller observes shared recovery; its cancellation never retires that recovery. */
export async function confirmRemotePtyAttachment(
  owner: AttachmentOwner,
  parentSignal?: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([owner.signal, ...(parentSignal ? [parentSignal] : [])]);
  const original = owner.state();
  let revision = original.revision;
  const unconfirmed = () =>
    new RemoteAgentPtyError(
      "PTY_ATTACH_UNCONFIRMED",
      "Remote terminal attachment is unconfirmed; no process was restarted.",
    );
  try {
    signal.throwIfAborted();
    if (!original.active || original.pid <= 0) throw unconfirmed();
    await owner.retry();
    signal.throwIfAborted();
    const recovered = owner.state();
    revision = recovered.revision;
    if (!recovered.active || recovered.pid !== original.pid) throw unconfirmed();
    await owner.attach(original.pid, signal);
    signal.throwIfAborted();
    const confirmed = owner.state();
    if (
      !confirmed.active ||
      confirmed.recovering ||
      confirmed.revision !== revision ||
      confirmed.pid !== original.pid
    )
      throw unconfirmed();
    owner.assertInputUsable();
  } catch (cause) {
    // In particular, a late cancelled observer must not re-fence recovered input.
    if (!signal.aborted) owner.failed(revision, unconfirmed());
    throw cause;
  }
}
