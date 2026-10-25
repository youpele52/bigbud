export const V2_WINDOWS_ACL_PROGRAM: string;
export function validateV2WindowsAcl(root: string, snapshot: unknown): void;
export function inspectV2WindowsAcl(root: string, signal?: AbortSignal): Promise<void>;
export function v2WindowsPowerShellEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
