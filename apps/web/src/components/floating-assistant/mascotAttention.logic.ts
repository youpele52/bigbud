const MASCOT_ATTENTION_CHANNEL = "bigbud-mascot-attention";

function createAttentionChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(MASCOT_ATTENTION_CHANNEL);
  } catch {
    return null;
  }
}

export function announceMascotAttention(): void {
  const channel = createAttentionChannel();
  if (!channel) return;
  // BroadcastChannel.postMessage has no targetOrigin; oxlint models Window.postMessage.
  // oxlint-disable-next-line require-post-message-target-origin
  channel.postMessage({ kind: "attention" });
  channel.close();
}

export function subscribeMascotAttention(listener: () => void): () => void {
  const channel = createAttentionChannel();
  if (!channel) return () => undefined;
  const onMessage = () => {
    listener();
  };
  channel.addEventListener("message", onMessage);
  return () => {
    channel.removeEventListener("message", onMessage);
    channel.close();
  };
}
