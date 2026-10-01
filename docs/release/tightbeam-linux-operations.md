# Surf Ace standalone Linux server operations

This v0.2.4 runbook applies only to product commit
`6a98c7a8b6260d0acc4c95132825e81a5f7ba4ad` and PostgreSQL 16. It assumes a
single configured allocator fleet, one server process at a time, and an
already-provisioned PostgreSQL primary with its configured synchronous witness.
The archive never installs a service or provisions, upgrades, or changes a host.

## Linux Electron archive launch contract

The deterministic ZIP contains `Surf Ace/surf-ace`, a small launcher that
executes the adjacent `surf-ace-bin` with Chromium's `--no-sandbox` flag. A
ZIP extracted by an ordinary user cannot reliably preserve a root-owned
setuid `chrome-sandbox` helper, so the package does not depend on that helper.
This intentionally means Chromium's local process sandbox is disabled for
this Linux package; the release's network trust boundary remains the operator's
tailnet. Do not treat the ZIP as providing an additional local sandbox boundary.
The automated headless smoke also adds `--disable-gpu` and
`--disable-dev-shm-usage`; those are test-environment flags, not added by the
public launcher.

## Validate and run one foreground owner

Keep the server JSON readable only by the service owner (`chmod 0600`). It must
contain exactly `listenHost`, `listenPort`, `hostLockPath`, `name`, and `custody`
(`name` is optional). `custody` is the existing `AllocatorServerConfig` custody
shape: `expectedClusterSystemId`, `fleetId`, `primaryUrl`, `recoveryUrl`,
`witnessApplicationName` (`surf_ace_witness`), `witnessPhysicalSlot`,
`witnessServerId`, and `witnessUrl`. URLs and lock paths are validated without
printing their values. The cluster system ID must match the PostgreSQL primary.

```sh
./bin/surf-ace-server validate --config /etc/surf-ace-server/production.json
./bin/surf-ace-server start --config /etc/surf-ace-server/production.json
```

`start` stays in the foreground, holds the existing host lock, and releases the
server and allocator lease on `SIGTERM` or `SIGINT`. A second process using the
same lock path must not be started. The packaged
`service/surf-ace-server@.service` is an optional systemd unit template for an
operator to review and install separately; the release tooling does not copy it
into systemd, reload a manager, enable it, or start a service. Configure its
instance file under `/etc/surf-ace-server/` and keep the config owned by the
`surf-ace` service account with mode `0600`. The launcher defaults the packaged
server diagnostic log to `client-flight-recorder.log` beside its host lock;
the unit template explicitly places it in its owner-only runtime directory.
Choose a run-owned writable directory and keep it private when using a custom
`SURF_ACE_CLIENT_DIAGNOSTIC_LOG` override.

Check that the registry WebSocket endpoint accepts a health handshake without
registering a client or mutating allocator state:

```sh
./bin/surf-ace-server health --endpoint ws://controller.example:19001/ws
```

The command normalizes the endpoint to `/ws`, requires the WebSocket handshake
to open, closes the probe connection, and uses a bounded five-second timeout.
It emits no credentials. Health success is not a substitute for the CLI's
current/no-loss reads.

## Schema and upgrade boundary

For an empty PostgreSQL 16 fleet, initialize with
`schemas/allocator/001_allocator.sql`. For an existing v0.2.3 fleet, v0.2.4
ships `schemas/allocator/002_fleet_panes.sql`. It adds the separate monotonic
pane counter and journal-backed claim function without changing the existing
journal head. The server does not auto-migrate. Stop the allocator and verify
the writer lease is released before applying 002. The migration refuses an
active lease, an in-progress restore, or an unsupported state version.

Before touching the serving database, capture a PostgreSQL base backup and a
schema/data `pg_dump` in a restricted run directory. Restore the backup into
a disposable staging cluster with its own witness and apply 002 there first;
verify the pre- and post-migration head sequence/hash are identical, the
accepted-state pane fence starts at 1, pane claims advance it, and restart and
restore do not reuse a number. Run the two-client smoke against that staging
allocator. After production migration, preserve the backup until the v0.2.4
qualification settles. If migration fails before commit, PostgreSQL rolls it
back atomically. If a later rollback is required, stop the writer and restore
the verified pre-migration base backup into a new cluster; never drop the pane
column or rewind the live counter in place.

## Backup, staged restore, validation, and rollback

Perform a planned maintenance change with a single writer. Store backup and
client output in a run-owned directory with restrictive permissions. Use a
PostgreSQL service file or `.pgpass` (mode `0600`) so database passwords are not
placed in command arguments or logs.

1. Confirm the configured primary and witness are healthy. Run packaged CLI
   `list` against each intended client's direct `/ws` endpoint, then scoped
   `capture-pane` and endpointless local `read` against that same client. Bind
   every operation to the exact surface and numeric pane; require
   `cacheStatus=current` and `consumableLoss=null` for every sampled pane, and
   prove sibling panes remain isolated. Save the output and exact
   product/package/config hashes. The CLI endpoint is not the registry endpoint.
2. Quiesce all client CLI mutations and verify no smoke client is still
   running. The local acceptance service is an isolated fixture; keep its
   registry process up while taking the consistent PostgreSQL custom-format
   snapshot, and record the pre-backup allocator projection. Never take this
   step against a shared or production database.
3. Create a restricted custom-format database backup and verify that PostgreSQL
   can enumerate its contents:

   ```sh
   umask 077
   pg_dump --format=custom --file "$BACKUP_FILE" "$PGSERVICE_DATABASE"
   pg_restore --list "$BACKUP_FILE" > "$BACKUP_FILE.list"
   ```

4. Create a separate disposable PostgreSQL 16 staging cluster with the required
   roles, witness, and an empty copy initialized from the packaged
   `001_allocator.sql`. Restore the backup into staging using
   `pg_restore --clean --if-exists --exit-on-error --dbname "$STAGING_DATABASE"
   "$BACKUP_FILE"`. Never restore over the original database. Bind the staging
   configuration to its own actual cluster system ID, the restored fleet ID,
   its own witness URLs, a distinct host-lock path, and a loopback-only listener.
5. Start the packaged foreground launcher against staging. Require a successful
   registry `/ws` health handshake. The allocator projection captured before
   server startup must match the backup source. While the service is active,
   require the same semantic allocator rows and journal head, exactly one
   append-only custody revision-head row for the writer lease, and a valid
   writer lease. A second packaged health handshake must leave the complete
   projection unchanged. On clean server shutdown, require the matching single
   lease-release revision-head row, null lease fields, and unchanged semantic
   rows/journal. These are the only allowed service-lifecycle differences; a
   health check is not allowed to advance allocator state. This staging check
   proves PG/schema/registry service health only; it does not route CLI
   operations through the registry. Use the separately packaged-CLI receipts
   from step 1, which target the actual client `/ws` endpoints, to verify
   identity, labels, topology/content/history, `cacheStatus=current`, and
   `consumableLoss=null` against the saved semantic baseline. A successful SQL
   restore alone is insufficient.
6. For rollback qualification, stop the staging server and discard only the
   run-owned staging cluster. Keep the original database untouched. For a
   planned PostgreSQL restart, first cleanly stop the packaged registry and
   require its writer lease to be released. Then restart the original primary
   and witness from their same data directories, require the same PostgreSQL
   system identifier, synchronized witness, and unchanged allocator
   projection. Start the packaged registry again and require a healthy `/ws`
   handshake before starting the baseline Electron client and repeating
   direct-client CLI list/capture/read checks against its own `/ws` endpoint.
   This qualifies an orderly stop/restart/start sequence, not transparent
   recovery of an open registry process across an abrupt PostgreSQL restart. If
   staging or validation fails, this retained original is the rollback target;
   the smoke records this strategy as `discard-staging-and-retain-original`.
   Do not promote staging and do not perform an in-place restore. Any actual
   endpoint or database cutover is an operator action outside this package and
   requires a separate change plan.
7. Preserve the backup, restore/list output, before/staged/rollback semantic
   receipts, process exit/health results, and cleanup result together. Remove
   only the explicitly run-owned staging data after those receipts are sealed.

The local packaged smoke performs this sequence against disposable PostgreSQL
16 clusters and verifies that the original primary's allocator projection is
unchanged by staging and same-data-directory restart. The Linux smoke receipt
retains the raw CLI request argv, endpoint, exit status, stdout, and stderr
bytes (base64 plus SHA-256) before temporary smoke files are removed. Client
registration and direct-to-client CLI observations are recorded separately
from registry health.
An iPad disconnect is an ordinary client lifecycle condition, not by itself a
topology failure. The smoke does not connect to a shared server or run a host
service manager.
