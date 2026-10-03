# Native migration validation — authorized temporary disk-backed swap

User explicitly authorized temporary swap to continue migration validation.
Parent provisioned active8GiB `/var/tmp/opencode-swap/migration-20261002.swap`,
mode600, no fstab change. Child verified active swap; did not alter host settings,
terminate processes or clean other work. Original profiles remain untouched.

`/tmp` is tmpfs,95%full (118MiBfree); new validation logs and synthetic profiles
use ignored disk-backed migration `target/migration-validation` and
`target/migration-test-profiles`, not large tmpfs artifacts.

Parent independent STATIC receipt P2 correction CLOSED exactfull10fieldreadback
inside transaction, missing/alteredIntegrityrollback checkpointretire; not test
rerun. Subsequently child ran pending targeted regressionPASS, current scoped
175testsPASS (162library+10bootstrap+1branding+2transport), releasePASS with
singlejob/debug0/incremental0 existingcache. Wider parity/activation remains gated.
