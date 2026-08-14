# @surf-ace/extension

OpenClaw Surf Ace extension package.

This package owns:

- Bonjour/mDNS discovery for `_surf-ace._tcp`
- Persistent WebSocket connection jobs per paired surface
- Local pane content/readback buffers for `surf_ace_read`
- OpenClaw tool registration for Surf Ace surface operations

## Provider Configuration

Surf Ace provider startup requires `SURF_ACE_PROVIDER_ALLOWED_HOSTS`. Set it to the approved comma-separated host names. Startup fails before provider state resolution when the value is absent, malformed, or excludes the current host.

Deploy provider changes by setting `SURF_ACE_EXTENSION_DEPLOY_HOST` to a valid destination host name and running `make -C packages/extension deploy-provider`. The target rejects missing values, schemes, users, ports, paths, and malformed host names before packaging. It preserves the provider identity/runtime files, `lockless-controller-identity.json`, and the complete `lockless-endpoints/` state tree while deleting stale package artifacts.

## OpenClaw Tool Admission

The extension registers the `surf_ace_*` tools, but OpenClaw will not expose them from the normal coding tool profile unless the Surf Ace plugin is explicitly admitted in `~/.openclaw/openclaw.json`.

Required OpenClaw config:

    {
      "tools": {
        "profile": "coding",
        "alsoAllow": ["surf-ace"]
      },
      "plugins": {
        "allow": ["surf-ace"],
        "entries": {
          "surf-ace": { "enabled": true }
        }
      }
    }

Use `tools.alsoAllow` so Surf Ace is added to the coding profile. Do not replace it with `tools.allow` unless the session is intentionally restricted to plugin tools only.

Verification must happen through the official tool surface: a normal OpenClaw session should declare `surf_ace_*`, and a harmless `surf_ace_list` should succeed. Logs, direct HTTP/WS calls, DNS-SD, screenshots, or remembered pane IDs are useful diagnostics but are not installation proof.

For an authorized retained-state cutover, use `surf_ace_list`, consume every current pane with `surf_ace_read` until the returned compatibility boundary is complete, and then invoke `surf_ace_prepare_migration_now({ fingerprint })`. Listing, startup, discovery, and pairing never create preparation. Preserve the exact preparation receipt for restart/retry recovery.

Before replacing the amended extension with a captured pre-amendment package, run `make -C packages/extension rollback-preflight STATE_FILE=/path/to/surf-ace-runtime-state.json`. A preparation record returns `rollback_requires_full_reset`; do not replace package bytes or restart the gateway. Only the approved byte-exact two-product baseline reset permits the later forward deployment to create a new migration ID.

## Topology Soak Proof Gate

Topology soak reports must cite the governing procedure in `<spec-root>/surf-ace/specs/fleet-soak-procedure.md` and cannot pass on pane count alone. A normal OpenClaw session must declare the official `surf_ace_*` tools, harmless `surf_ace_list` must succeed through that tool path, and the returned recursive topology must be cross-checked against independent rendered/provider truth such as `surf_ace_capture_pane` metadata/pixels plus `surf_ace_read` for the same `fingerprint` + opaque `paneId` tuple.

Direct runtime calls, logs, DNS-SD, screenshots, local state files, and debug JSON are diagnostic-only. They may explain a mismatch, but they do not replace the official tool-surface admission gate or the rendered/provider topology cross-check.

## Native GUI Materialization Proof Gate

Native GUI/app proof must also use the official provider path. A passing proof starts with `surf_ace_list` returning the target surface/pane as connected, admitted, and actionable, launches with `surf_ace_launch_native_app` and `confirmed:true`, and verifies the returned target apply evidence for that same pane. `nativeHost` and `overlayRegions` must both be `applied`, and a Surf Ace pane capture or equivalent approved product capture must show the app visibly rendered in the pane.

Direct compositor calls, `native_pane.host`, disabled demo fixtures, fake WS servers, mocked compositor status, and manually hosted windows are lower-layer diagnostics only. They may be used to isolate failures inside Electron/compositor materialization, but they must not be reported as Surf Ace production proof or offered as a user-facing escape hatch.

## File-Backed Content Pushes

When `surf_ace_push` receives `sourcePath`, the provider reads that file before sending the pane mutation and stores/sends those bytes as the pane content. Placeholder `content` is not proof of rendered bytes; `surf_ace_read` and `surf_ace_capture_pane` should reflect the materialized source content for the same fingerprint and pane id.
