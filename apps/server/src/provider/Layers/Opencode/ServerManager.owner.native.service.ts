import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";

export const SYNTHETIC_OPENCODE_HEALTH_VERSION = "synthetic-opencode-v1-proof";

// A fixed ELF protocol recorder, not the OpenCode product. It distinguishes the owner's
// readiness probe from the SDK request and checks that the SDK used the leased cwd.
const source = String.raw`
#include <arpa/inet.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int sdk_health(const char *request) {
  const char prefix[] = "GET /global/health?directory=";
  if (strncmp(request, prefix, sizeof(prefix) - 1) != 0) return 0;
  request += sizeof(prefix) - 1;
  char cwd[1024];
  if (!getcwd(cwd, sizeof(cwd))) return 0;
  // The only escaped characters in the fixture cwd are its slashes.
  for (const char *ch = cwd; *ch; ch++) {
    if (*ch == '/') {
      if (strncmp(request, "%2F", 3) != 0) return 0;
      request += 3;
    } else if (*request++ != *ch) {
      return 0;
    }
  }
  return strncmp(request, " HTTP/1.1\r\n", 11) == 0;
}

static void respond(int peer) {
  char request[4096] = {0};
  size_t used = 0;
  while (!strstr(request, "\r\n\r\n")) {
    if (used == sizeof(request) - 1) return;
    ssize_t n = recv(peer, request + used, sizeof(request) - used - 1, 0);
    if (n <= 0) return;
    used += (size_t)n;
  }
  const char probe[] = "GET /global/health HTTP/1.1\r\n";
  const int startup = strncmp(request, probe, sizeof(probe) - 1) == 0;
  const int sdk = sdk_health(request);
  const char *body = startup ? "{\"healthy\":true,\"version\":\"startup\"}" :
    sdk ? "{\"healthy\":true,\"version\":\"${SYNTHETIC_OPENCODE_HEALTH_VERSION}\"}" : "{}";
  char response[512];
  const int length = snprintf(response, sizeof(response),
    "HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s",
    startup || sdk ? "200 OK" : "404 Not Found", strlen(body), body);
  if (length <= 0 || (size_t)length >= sizeof(response)) return;
  for (int sent = 0; sent < length;) {
    ssize_t n = send(peer, response + sent, (size_t)(length - sent), MSG_NOSIGNAL);
    if (n <= 0) return;
    sent += (int)n;
  }
}

int main(int argc, char **argv) {
  if (argc != 6 || strcmp(argv[1], "serve") || strcmp(argv[2], "--hostname") ||
      strcmp(argv[3], "127.0.0.1") || strcmp(argv[4], "--port") || strcmp(argv[5], "4096")) return 2;
  const int listener = socket(AF_INET, SOCK_STREAM, 0);
  const int reuse = 1;
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons(4096),
    .sin_addr = { .s_addr = htonl(INADDR_LOOPBACK) } };
  if (listener < 0 || setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) ||
      bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 8)) return 3;
#if !defined(STALL_READINESS)
  puts("opencode server listening on http://127.0.0.1:4096");
  if (fflush(stdout)) return 4;
#endif
  for (;;) {
    int peer = accept(listener, NULL, NULL);
    if (peer < 0) return 5;
    respond(peer);
    close(peer);
  }
}
`;

export async function compileSyntheticOpencode(
  root: string,
  binaryPath: string,
  stallReadiness = false,
) {
  const sourcePath = path.join(root, "synthetic-opencode.c");
  await writeFile(sourcePath, source, { flag: "wx", mode: 0o600 });
  execFileSync(
    "/usr/bin/cc",
    [
      "-Wall",
      "-Wextra",
      "-Werror",
      ...(stallReadiness ? ["-DSTALL_READINESS"] : []),
      sourcePath,
      "-o",
      binaryPath,
    ],
    {
      cwd: root,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      timeout: 10_000,
    },
  );
}
