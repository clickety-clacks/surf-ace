# Central-server Bonjour fallback

Electron first tries optional SURF_ACE_SERVER using ordinary ws/wss transport. A successful configured registration does not start the browser. If configuration is absent, invalid or registration fails, the client browses _surf-ace._tcp and tries advertisements marked role=server. It sends the existing stable client identity and surface set, persists central labels, and keeps the selected route while healthy. A bounded failed selection reports no_surf_ace_server and the runtime retries. While fallback is healthy, each synchronization also tries the configured route. Successful registration and persistence promote that route and close the fallback connection. Failed probes leave fallback selected; failed persistence rolls local labels back. Configured sockets are reused until failure.

Clients no longer publish themselves as the primary discovery direction. Existing standalone surface-server APIs remain for compatibility. There is no per-client Tailscale service or alternate Tailscale discovery path.

The central serving bootstrap reuses AllocatorServer and BonjourAdvertiser. Build it with:

    pnpm --filter @surf-ace/electron build

The exported startCentralServer(config, name) in packages/electron/dist/central-server.cjs starts the existing custody-backed server and publishes its actual port with role=server. Pass the existing AllocatorServerConfig from the serving environment; custody must already be initialized. The returned close() stops both publisher and listener. This is a callable build artifact, not an installed daemon. No database provisioning or service installation is performed.

Focused isolated real discovery proof:

    pnpm --filter @surf-ace/allocator exec node --import tsx --test --test-name-pattern="configured-first server Bonjour" src/postgres.integration.test.ts

The fixture publishes a temporary central server and browses real Bonjour, filtering to its unique name. It proves configured success suppresses browsing, absent/unreachable configuration triggers discovery, no matching server reports a bounded error, and one-plus-two-surface clients persist a1/b1/c1 with reconnect/dedup. Eezo/macOS execution is same-host real multicast/DNS-SD and TCP, not cross-machine LAN or live MagicDNS/Tailscale proof. Linux execution remains unestablished within the authorized host scope. No deployment, GUI, E2E or soak claim.

Recovery evidence uses two TCP routes to the same allocator authority, with the configured route enabled/disabled in the fixture. It does not assert label continuity between different fleets or allocator authorities. Repeated recovery/fallback cycles preserve stable identities and the allocation fence, and shutdown closes route sockets.
