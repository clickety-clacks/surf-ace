# Configured central server registration

This first increment adds an optional `SURF_ACE_SERVER=ws://server-name:port` to the Electron client. The address uses ordinary WebSocket DNS transport; LAN hostnames, MagicDNS names and stable Tailscale Service names require no alternate discovery implementation. No Tailscale resources are provisioned.

The existing allocator server accepts `client.register` and `fleet.topology` using the existing v1 request/response envelope. It owns the registration snapshot and assigns global labels through the existing durable allocator authority. Clients supply their full persisted public-key fingerprint and local surface/pane identities; they do not supply fleet, allocator or authority configuration. Fingerprints identify registrations; this increment does not introduce authentication.

The server derives its stable authority key from its existing allocator identity and its owner anchor from its existing fleet identity. A composite client/surface key prevents different clients from sharing an allocation accidentally. Re-registering replaces that client's topology snapshot and reuses committed label assignments. Registration snapshots are in memory and rebuilt by periodic client registration after restart; label custody remains in PostgreSQL.

The Electron lifecycle registers every two seconds, applies returned window labels through existing SurfaceCore projection, and uses the existing guarded persistence path. A configured client suppresses the previous surface Bonjour advertisement. Without configuration the previously landed behavior remains available during this migration.

This increment covers configured routing only. Server Bonjour advertisement/discovery, fallback when configured routing fails, and recovery preference are subsequent increments. The old provider-browses-surfaces path is not claimed as the new architecture. No GUI launch, installed runtime, deployment, live LAN/MagicDNS/Tailscale or soak readiness is asserted by isolated network tests.

Run focused real TCP registration evidence from the repository root:

    pnpm --filter @surf-ace/allocator exec node --import tsx --test --test-name-pattern="configured server registers" src/postgres.integration.test.ts

The fixture starts isolated PostgreSQL custody and the real server, runs two production registration clients against it, reads a1/b1 fleet topology, reads persisted surface labels, restores client identity, verifies reconnect/concurrent deduplication and label fence continuity, rejects invalid identity, then cleans temporary infrastructure.
