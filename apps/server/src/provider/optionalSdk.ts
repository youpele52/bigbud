/**
 * Lazy optional provider SDK modules (P7 increment 5, WP-5C).
 *
 * Optional provider SDKs are loaded with a literal dynamic `import()` at first use, never at
 * module evaluation. A backend whose graph lacks an unselected provider's SDK therefore still
 * bootstraps; the failure surfaces only when that provider is used, as a typed error naming the
 * missing package. Literal specifiers keep the bundler (and the backend graph loader policy)
 * able to see every edge: no computed specifier and no new loader site is introduced here.
 */

export class OptionalSdkUnavailableError extends Error {
  override readonly name = "OptionalSdkUnavailableError";
  constructor(
    readonly packageName: string,
    options?: { readonly cause?: unknown },
  ) {
    super(
      `The ${packageName} SDK is not available in this backend; the provider that needs it cannot start.`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
  }
}

export interface OptionalSdk<T> {
  /** Loads once; concurrent callers share the load. A failed load is retried on the next call. */
  readonly load: () => Promise<T>;
  /** Sync access for code that runs after `load()` resolved (constructors, option builders). */
  readonly loaded: () => T;
}

export function makeOptionalSdk<T>(
  packageName: string,
  importer: () => Promise<T>,
): OptionalSdk<T> {
  let module: T | undefined;
  let pending: Promise<T> | undefined;
  let failure: OptionalSdkUnavailableError | undefined;
  const load = () => {
    if (module !== undefined) return Promise.resolve(module);
    pending ??= importer().then(
      (value) => {
        module = value;
        failure = undefined;
        return value;
      },
      (cause: unknown) => {
        pending = undefined;
        failure = new OptionalSdkUnavailableError(packageName, { cause });
        throw failure;
      },
    );
    return pending;
  };
  const loaded = () => {
    if (failure) throw failure;
    if (module === undefined)
      throw new Error(`${packageName} was used before it was loaded; await its load() first.`);
    return module;
  };
  return { load, loaded };
}
