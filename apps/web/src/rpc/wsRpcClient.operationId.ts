import { randomUUID } from "~/lib/utils";

/** A stable caller identity per mutation, so an ambiguous attempt is never replayed as new. */
export function withOperationId<T extends { readonly operationId?: string | undefined }>(
  input: T,
  prefix: string,
): T {
  return input.operationId ? input : { ...input, operationId: `${prefix}-${randomUUID()}` };
}
