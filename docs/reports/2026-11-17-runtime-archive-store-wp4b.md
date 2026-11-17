# Runtime archive store and newer-schema refusal (M3 WP-4B)

**Date:** 17 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M3 WP-4B
**Status:** Implemented with focused tests. Not committed. The archive store is a library for
WP-4C/4D and is not wired into setup.

## Newer-schema startup refusal (all modes)

`runMigrations` now calls `assertDatabaseSchemaNotNewer(latestMigrationId)` before anything else.
When the highest applied migration id is above the highest id this build knows, startup fails with
`DatabaseSchemaNewerThanRuntimeError`:

> The database schema is newer than this bigbud build: migration 174_Example is applied, but this
> build only knows migrations up to 173. Startup is refused so an older runtime never uses a newer
> schema. Run a build that includes migration 174, or restore a database backup made by this
> version.

Every local and remote startup migrates through `runMigrations`, so the guard covers all modes.

### Dev-flow impact

- Migration history was checked: ids were renumbered within the range many times, but no id
  ever went above the current maximum. The local dev database (`~/.bigbud/dev/state.sqlite`)
  is at 172 and the packaged one (`~/.bigbud/userdata/state.sqlite`) is at 159, so neither
  trips the guard today.
- **New:** once any checkout runs a migration against a shared database, an older checkout
  refuses to start on that database. For example, after running dev with the uncommitted
  `173_RemoteBackendProfiles`, switching to a commit without it (stash, branch switch, bisect)
  refuses startup on `~/.bigbud/dev`. Before this change it started silently on a schema it did
  not know. Remedies: go back to a checkout that has the migration, use a separate
  `BIGBUD_HOME` for older checkouts, or restore a backup.
- If a migration is ever renumbered downward after it has run on a dev database, that
  database now refuses to start until the old row is removed. Keep new ids above every id that
  has already run anywhere.

## Runtime archive store

Files: `apps/server/src/remote-backend/runtimeArchive.{key,pointer,store,retention}.ts`.

- **Where:** a private root the caller chooses. The store refuses a root inside (or containing)
  backend home, the backend state dir, service config or agent roots, the same separation setup
  already enforces for executable graphs. `runtimeArchiveStoreRoot(home, authority)` suggests
  `~/.bigbud/backend-runtimes/<authority>`, next to `backend-services/<authority>`. This is a
  deliberate change from "under the remote state root": a graph inside backend state would fail
  setup's graph-separation check.
- **Layout:** `pointers/pointer-<sequence>` (numbered no-replace files, highest wins),
  `entries/<version>@<manifest sha>/graph/` (the extraction), `entries/<key>/entry-v1` (written
  last, marks the entry complete), `trash/`.
- **Flow:** reserve (durably adds the key to `pending` before its directory exists) → extract →
  `verifyBackendGraph` in place → record (revalidates the original token and writes the entry) →
  activate (durable commit: new active, old active becomes `previous`) → prune.
- **Retention:** keeps active, previous, every pending, every pinned and every caller-supplied
  in-use version. Pruning only reads the latest durable pointer, so it always runs after the
  commit that released a version, and does nothing before the first commit. Pruned entries are
  renamed into `trash/` first, so a crash leaves either a whole entry or a trash member that the
  next run removes. A pointer change during pruning stops it.

## Notes for WP-4C/4D

- Hold the single-flight update lock for every store call and pass its assertion as
  `checkpoint`.
- Pass running versions as `inUse` to `pruneRuntimeArchives`; the store cannot see processes.
- Call `releaseRuntimeArchive` for failed staging; otherwise the reservation is kept forever.
- The store keeps extractions only, not the downloaded archive file.
- Setup still runs a graph from its own `--graph-root`. Moving setup onto the store is part of
  the update work, not this package.
