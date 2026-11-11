# Thin Bun wrappers. Full reference: docs/COMMANDS.md
set positional-arguments

# Show available commands without running a workflow.
default:
    @just --list

dev *args:
    bun run dev "$@"

dev-server *args:
    bun run dev:server "$@"

dev-web *args:
    bun run dev:web "$@"

dev-mobile-web *args:
    bun run dev:mobile-web "$@"

dev-marketing *args:
    bun run dev:marketing "$@"

dev-desktop *args:
    bun run dev:desktop "$@"

start *args:
    bun run start "$@"

start-desktop *args:
    bun run start:desktop "$@"

start-marketing *args:
    bun run start:marketing "$@"

start-mock-update-server *args:
    bun run start:mock-update-server "$@"

build *args:
    bun run build "$@"

build-marketing *args:
    bun run build:marketing "$@"

build-mobile-web *args:
    bun run build:mobile-web "$@"

build-mobile-web-desktop *args:
    bun run build:mobile-web:desktop "$@"

build-desktop *args:
    bun run build:desktop "$@"

typecheck *args:
    bun run typecheck "$@"

lint *args:
    bun run lint "$@"

check-test-file-length *args:
    bun run check:test-file-length "$@"

test *args:
    bun run test "$@"

test-desktop-smoke *args:
    bun run test:desktop-smoke "$@"

fmt *args:
    bun run fmt "$@"

fmt-check *args:
    bun run fmt:check "$@"

build-contracts *args:
    bun run build:contracts "$@"

build-workspace-agent *args:
    bun run build:workspace-agent "$@"

build-desktop-supervisor *args:
    bun run build:desktop-supervisor "$@"

smoke-desktop-supervisor *args:
    bun run smoke:desktop-supervisor "$@"

verify-packaged-desktop-supervisor *args:
    bun run verify:packaged-desktop-supervisor "$@"

dist-desktop-artifact *args:
    bun run dist:desktop:artifact "$@"

dist-desktop-dmg *args:
    bun run dist:desktop:dmg "$@"

dist-desktop-dmg-arm64 *args:
    bun run dist:desktop:dmg:arm64 "$@"

dist-desktop-dmg-x64 *args:
    bun run dist:desktop:dmg:x64 "$@"

dist-desktop-linux *args:
    bun run dist:desktop:linux "$@"

dist-desktop-linux-dir *args:
    bun run dist:desktop:linux:dir "$@"

dist-desktop-linux-deb *args:
    bun run dist:desktop:linux:deb "$@"

verify-desktop-linux-artifact *args:
    bun run verify:desktop:linux-artifact "$@"

dist-desktop-win *args:
    bun run dist:desktop:win "$@"

release-smoke *args:
    bun run release:smoke "$@"

clean *args:
    bun run clean "$@"

desktop-dev *args:
    bun run --cwd apps/desktop dev "$@"

desktop-dev-server-bundle *args:
    bun run --cwd apps/desktop dev:server-bundle "$@"

desktop-dev-bundle *args:
    bun run --cwd apps/desktop dev:bundle "$@"

desktop-dev-electron *args:
    bun run --cwd apps/desktop dev:electron "$@"

desktop-build *args:
    bun run --cwd apps/desktop build "$@"

desktop-start *args:
    bun run --cwd apps/desktop start "$@"

desktop-typecheck *args:
    bun run --cwd apps/desktop typecheck "$@"

desktop-test *args:
    bun run --cwd apps/desktop test "$@"

desktop-smoke-test *args:
    bun run --cwd apps/desktop smoke-test "$@"

marketing-dev *args:
    bun run --cwd apps/marketing dev "$@"

marketing-prebuild *args:
    bun run --cwd apps/marketing prebuild "$@"

marketing-build *args:
    bun run --cwd apps/marketing build "$@"

marketing-preview *args:
    bun run --cwd apps/marketing preview "$@"

marketing-typecheck *args:
    bun run --cwd apps/marketing typecheck "$@"

mobile-web-dev *args:
    bun run --cwd apps/mobile-web dev "$@"

mobile-web-build *args:
    bun run --cwd apps/mobile-web build "$@"

mobile-web-build-desktop *args:
    bun run --cwd apps/mobile-web build:desktop "$@"

mobile-web-preview *args:
    bun run --cwd apps/mobile-web preview "$@"

mobile-web-typecheck *args:
    bun run --cwd apps/mobile-web typecheck "$@"

mobile-web-test *args:
    bun run --cwd apps/mobile-web test "$@"

mobile-web-test-browser *args:
    bun run --cwd apps/mobile-web test:browser "$@"

server-dev *args:
    bun run --cwd apps/server dev "$@"

server-build *args:
    bun run --cwd apps/server build "$@"

server-thread-tools-manifest *args:
    bun run --cwd apps/server thread-tools:manifest "$@"

server-thread-tools-manifest-check *args:
    bun run --cwd apps/server thread-tools:manifest:check "$@"

server-thread-tools-native-qualification-check *args:
    bun run --cwd apps/server thread-tools:native-qualification:check "$@"

server-thread-tools-native-qualification-prepare *args:
    bun run --cwd apps/server thread-tools:native-qualification:prepare "$@"

server-start *args:
    bun run --cwd apps/server start "$@"

server-prepare *args:
    bun run --cwd apps/server prepare "$@"

server-prepack *args:
    bun run --cwd apps/server prepack "$@"

server-typecheck *args:
    bun run --cwd apps/server typecheck "$@"

server-test *args:
    bun run --cwd apps/server test "$@"

server-test-groups *args:
    bun run --cwd apps/server test:groups "$@"

server-test-browser-install *args:
    bun run --cwd apps/server test:browser:install "$@"

server-benchmark-startup-catalog *args:
    bun run --cwd apps/server benchmark:startup-catalog "$@"

server-benchmark-mobile-recovery-memory *args:
    bun run --cwd apps/server benchmark:mobile-recovery-memory "$@"

web-dev *args:
    bun run --cwd apps/web dev "$@"

web-build *args:
    bun run --cwd apps/web build "$@"

web-prepare *args:
    bun run --cwd apps/web prepare "$@"

web-preview *args:
    bun run --cwd apps/web preview "$@"

web-typecheck *args:
    bun run --cwd apps/web typecheck "$@"

web-test *args:
    bun run --cwd apps/web test "$@"

web-test-browser *args:
    bun run --cwd apps/web test:browser "$@"

web-test-browser-install *args:
    bun run --cwd apps/web test:browser:install "$@"

contracts-dev *args:
    bun run --cwd packages/contracts dev "$@"

contracts-build *args:
    bun run --cwd packages/contracts build "$@"

contracts-prepare *args:
    bun run --cwd packages/contracts prepare "$@"

contracts-typecheck *args:
    bun run --cwd packages/contracts typecheck "$@"

contracts-test *args:
    bun run --cwd packages/contracts test "$@"

effect-acp-prepare *args:
    bun run --cwd packages/effect-acp prepare "$@"

effect-acp-typecheck *args:
    bun run --cwd packages/effect-acp typecheck "$@"

shared-prepare *args:
    bun run --cwd packages/shared prepare "$@"

shared-typecheck *args:
    bun run --cwd packages/shared typecheck "$@"

shared-test *args:
    bun run --cwd packages/shared test "$@"

scripts-prepare *args:
    bun run --cwd scripts prepare "$@"

scripts-typecheck *args:
    bun run --cwd scripts typecheck "$@"

scripts-test *args:
    bun run --cwd scripts test "$@"

install *args:
    bun install "$@"

install-frozen *args:
    bun install --frozen-lockfile "$@"

# Require at least one test path or selector.
server-test-file +args:
    bun run --cwd apps/server vitest run "$@"
