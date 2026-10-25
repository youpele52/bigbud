import { describe, expect, it } from "vitest";

import { CliProxyConfigError, parseCliProxyConfig, resolveCliProxyConfig } from "./config.ts";

const validConfig = `
host: "127.0.0.1" # local only
port: 8317
api-keys:
  - "secret-key"
tls:
  enable: false
`;

function options(files: Readonly<Record<string, string>>) {
  return {
    exists: (candidate: string) => Object.hasOwn(files, candidate),
    readFile: (candidate: string) => {
      const content = files[candidate];
      if (content === undefined) throw new Error("missing fixture");
      return content;
    },
    homebrewConfigPath: "/brew/etc/cliproxyapi.conf",
    homeDirectory: "/home/test",
    workingDirectory: "/project",
  };
}

function expectConfigError(run: () => unknown, tag: CliProxyConfigError["_tag"]): void {
  try {
    run();
    throw new Error("Expected config error");
  } catch (error) {
    expect(error).toBeInstanceOf(CliProxyConfigError);
    expect((error as CliProxyConfigError)._tag).toBe(tag);
  }
}

describe("parseCliProxyConfig", () => {
  it("parses comments, quoted scalars, TLS, and only the api-keys list", () => {
    expect(
      parseCliProxyConfig(`
providers:
  - unrelated-list-item
host: 'localhost'
port: "8317"
api-keys:
  - 'first-key' # selected
  - "second-key"
tls:
  enable: true
`),
    ).toEqual({
      host: "localhost",
      port: "8317",
      apiKeys: ["first-key", "second-key"],
      tlsEnabled: true,
    });
  });

  it("rejects malformed relevant YAML instead of guessing", () => {
    expectConfigError(() => parseCliProxyConfig("api-keys: secret"), "ConfigMalformed");
    expectConfigError(() => parseCliProxyConfig('host: "unterminated'), "ConfigMalformed");
    expectConfigError(() => parseCliProxyConfig("tls:\n\tenable: true"), "ConfigMalformed");
  });
});

describe("resolveCliProxyConfig", () => {
  function resolve(content: string) {
    return resolveCliProxyConfig("/v8.yaml", options({ "/v8.yaml": content }));
  }

  it("reads v8 listener and client keys without selecting upstream secrets", () => {
    const result = resolve(`
config-version: 8
server:
  host: "::1"
  port: 9317
  tls: { enable: true }
access:
  api-keys: ["", " client-secret "]
api-keys:
  claude:
    - keys: [{ api-key: upstream-secret }]
`);
    expect(result.baseUrl.toString()).toBe("https://[::1]:9317/");
    expect(result.apiKey).toBe("client-secret");
    expectConfigError(
      () => resolve("api-keys: { claude: [{ keys: [{ api-key: upstream-secret }] }] }"),
      "MissingCredential",
    );
  });

  it("uses field presence for mixed-layout overrides including false and empty host", () => {
    const result = resolve(
      `${validConfig}
server: { host: "", port: 9317, tls: { enable: false } }
access: { api-keys: [v8-secret] }
`.replace("enable: false\n", "enable: true\n"),
    );
    expect(result.baseUrl.toString()).toBe("http://127.0.0.1:9317/");
    expect(result.apiKey).toBe("v8-secret");
    expectConfigError(() => resolve(`${validConfig}\nserver: { port: 0 }`), "InvalidPort");
    expectConfigError(
      () => resolve(`${validConfig}\naccess: { api-keys: [] }`),
      "MissingCredential",
    );
  });

  it("falls back per leaf, including TLS enable, without requiring migration", () => {
    const result = resolve(`${validConfig.replace("enable: false", "enable: true")}
config-version: 8
server: { host: localhost, tls: { cert: ignored } }
access: {}
`);
    expect(result.baseUrl.toString()).toBe("https://localhost:8317/");
    expect(result.apiKey).toBe("secret-key");
    expect(resolve("access: { api-keys: [client] }").baseUrl.toString()).toBe(
      "http://127.0.0.1:8317/",
    );
  });

  it.each([
    "server: null",
    "server: []",
    "server: { host: [] }",
    "server: { port: null }",
    "server: { tls: null }",
    "server: { tls: { enable: 1 } }",
    "access: []",
    "access: { api-keys: [123] }",
  ])("rejects malformed v8 shapes: %s", (section) => {
    expectConfigError(() => resolve(`${validConfig}\n${section}`), "ConfigInvalidShape");
  });

  it("enforces loopback safety on the winning v8 host", () => {
    expectConfigError(() => resolve(`${validConfig}\nserver: { host: 10.0.0.8 }`), "UnsafeAddress");
  });

  it("prefers an explicitly configured config file over discovered paths", () => {
    const configured = "/configured/config.yaml";
    const result = resolveCliProxyConfig(configured, options({ [configured]: validConfig }));

    expect(result.configPath).toBe(configured);
    expect(result.baseUrl.toString()).toBe("http://127.0.0.1:8317/");
    expect(result.apiKey).toBe("secret-key");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("uses the Homebrew config path before legacy defaults", () => {
    const homebrewConfig = "/brew/etc/cliproxyapi.conf";
    const result = resolveCliProxyConfig(
      undefined,
      options({
        [homebrewConfig]: validConfig,
        "/home/test/.cli-proxy-api/config.yaml": validConfig,
      }),
    );

    expect(result.configPath).toBe(homebrewConfig);
  });

  it("normalizes wildcard binds and brackets IPv6 loopback addresses", () => {
    const wildcard = resolveCliProxyConfig(
      "/wildcard.yaml",
      options({ ["/wildcard.yaml"]: validConfig.replace('"127.0.0.1"', '"0.0.0.0"') }),
    );
    const ipv6 = resolveCliProxyConfig(
      "/ipv6.yaml",
      options({ ["/ipv6.yaml"]: validConfig.replace('"127.0.0.1"', '"::1"') }),
    );

    expect(wildcard.baseUrl.toString()).toBe("http://127.0.0.1:8317/");
    expect(ipv6.baseUrl.toString()).toBe("http://[::1]:8317/");
  });

  it("uses HTTPS only when TLS is explicitly enabled", () => {
    const result = resolveCliProxyConfig(
      "/tls.yaml",
      options({ ["/tls.yaml"]: validConfig.replace("enable: false", "enable: true") }),
    );

    expect(result.baseUrl.toString()).toBe("https://127.0.0.1:8317/");
  });

  it("returns distinct typed failures for missing, unsafe, invalid, and credential-less config", () => {
    expectConfigError(() => resolveCliProxyConfig("/missing.yaml", options({})), "ConfigNotFound");
    expectConfigError(
      () =>
        resolveCliProxyConfig(
          "/unsafe.yaml",
          options({ ["/unsafe.yaml"]: validConfig.replace('"127.0.0.1"', '"10.0.0.8"') }),
        ),
      "UnsafeAddress",
    );
    expectConfigError(
      () =>
        resolveCliProxyConfig(
          "/port.yaml",
          options({ ["/port.yaml"]: validConfig.replace("8317", "70000") }),
        ),
      "InvalidPort",
    );
    expectConfigError(
      () =>
        resolveCliProxyConfig(
          "/protocol.yaml",
          options({ ["/protocol.yaml"]: `protocol: ftp\n${validConfig}` }),
        ),
      "UnsupportedProtocol",
    );
    expectConfigError(
      () =>
        resolveCliProxyConfig(
          "/credential.yaml",
          options({ ["/credential.yaml"]: validConfig.replace('  - "secret-key"', "") }),
        ),
      "MissingCredential",
    );
  });
});
