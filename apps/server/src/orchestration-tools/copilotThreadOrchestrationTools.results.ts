import type { ToolResultObject } from "@github/copilot-sdk";

export function successResult(message: string): ToolResultObject {
  return {
    textResultForLlm: message,
    resultType: "success",
    sessionLog: message,
  };
}

export function failureResult(message: string): ToolResultObject {
  return {
    textResultForLlm: message,
    resultType: "failure",
    error: message,
    sessionLog: message,
  };
}
