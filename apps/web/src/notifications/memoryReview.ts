export function memoryReviewNotification(kind: string) {
  switch (kind) {
    case "learning.memory.updated":
      return {
        type: "success" as const,
        title: "Memory updated",
        description: "bigbud saved new persistent memory from this conversation.",
      };
    case "learning.memory.retrying":
      return {
        type: "info" as const,
        title: "Memory review will retry",
        description: "Your saved memory is still available. bigbud will try this review again.",
      };
    case "learning.memory.rejected":
      return {
        type: "warning" as const,
        title: "Memory review output was rejected",
        description:
          "The proposed memory did not pass validation. Your saved memory is still available.",
      };
    case "learning.memory.failed":
      return {
        type: "error" as const,
        title: "Memory review failed",
        description: "bigbud could not finish this review. Your saved memory is still available.",
      };
    default:
      return null;
  }
}
