# T1770 Rejected-Architecture Proof Ledger — 2026-07-30

> Historical diagnostic evidence only. Flynn rejected the dedicated Tight Beam archetype and MCP adapter that this run exercised. Current Revision 11 requires one general standalone native `surf-ace` CLI plus a separate Tight Beam reusable-skill consumer of the identical executable, with no Tight-Beam-specific binary, MCP, or dedicated archetype. Nothing in this ledger proves the corrected product route, and the former quota/no-tool result is not a current product blocker. Corrected official proof remains prohibited until AC-CLI-09/CORR-09 approves the combined source and native macOS/Linux evidence.

## Result

T1770 is not ready for a product-readiness claim.

- The official OpenClaw controller path passed a fresh correlated production-client push, visible Markdown render, local read, provenance, and accessibility capture after review fixes.
- The official Tightbeam agent path is blocked before its first Surf Ace tool call by the available Claude model's weekly quota. The available Codex agent session loaded the Surf Ace identity and skill but did not expose the MCP tools.
- The exact `OpenClaw — Clawline` provenance example is not proven. The official OpenClaw session supplied no friendly chat label, so the production client correctly rendered the specified fallback `Unknown chat — Clawline`.

Fixtures, mocks, direct WebSocket calls, compositor-only calls, and uncorrelated logs remain diagnostic and are not used for the product claims below.

## Production client

- Build: packaged Electron production application, ad-hoc signed.
- `app.asar` SHA-256: `2aa843b053944026498b6be3be8f1aed66b165afeec140774f75683ad53994cc`.
- Surface: `sf_c0ad298c25da`.
- Discovery fingerprint: `c33b132d`.
- Proof WebSocket: `ws://127.0.0.1:65173/ws`.
- Proof CDP endpoint: `127.0.0.1:65174`.
- Artifact root: `/tmp/t1770-ui-proof-final.nNSejj/artifacts`.

The application was launched directly for the coordinated proof. No launchd entry, login item, autostart setting, or other persistence state was added, modified, loaded, unloaded, enabled, or disabled.

Exact launch command:

```sh
env SURF_ACE_BIND=127.0.0.1 SURF_ACE_PORT=65173 SURF_ACE_CLIENT_DIAGNOSTIC_LOG=/tmp/t1770-ui-proof-final.nNSejj/artifacts/client-flight-recorder.log 'packages/electron/dist/package/mac-arm64/Surf Ace.app/Contents/MacOS/Surf Ace' --user-data-dir=/tmp/t1770-ui-proof-final.nNSejj/user-data --remote-debugging-port=65174
```

Launch provenance: `/tmp/t1770-ui-proof-final.nNSejj/artifacts/launch-provenance.txt`, SHA-256 `26ddb3f55e396094453d8d3f65b84c409e9aa8fdffd76a282aa0f1ca66a63d99`.

## Official OpenClaw result

The isolated OpenClaw agent session called the official `surf_ace_list`, `surf_ace_push`, and `surf_ace_read` tools with three calls and zero tool failures.

- Controller instance: `ci_a40743c2f98f4983a6d6d85af8431f91`.
- Content: `T1770 official OpenClaw proof`.
- Content ID: `ct_0107824158a0431da28878bf3c993050`.
- History entry: `he_e10f6a741d654bef96ce240c1af32b76`.
- Pane: `1`.
- Revision: `1`.
- Mutation request: `rq_0ff6d81a531b41f394c77a4fdfd6b75e`.
- Correlated client commit sequence: `3`.
- Agent session trace: `/tmp/t1770-openclaw-proof.SxpIba/openclaw-state/agents/main/agent/codex-home/sessions/2026/07/30/rollout-2026-07-30T16-13-30-019fb54d-e999-7a00-821c-12b8bcccd5be.jsonl`, SHA-256 `f0d8dda1230f892abbdf39cb3b43ac646645897fb8ee25bb77e06779dae3ba41`.
- Client flight recorder: `/tmp/t1770-ui-proof-final.nNSejj/artifacts/client-flight-recorder.log`, SHA-256 `7245949fb88deb41b7237a6ecd51b094b5eb4857d97a63b9c816853ce38cb3c2`.

The client audit correlates the same controller, operation, request, surface, accepted result, and commit sequence. The production renderer converted the pristine bootstrap pane `0` to admitted pane `1` and later acknowledged the read at commit sequence `4`. It did not render the pushed Markdown: `pane_content_render` was followed by `Cannot read properties of undefined (reading 'replace')`, and the captured pane body was empty. The OpenClaw lockless adapter had forwarded the official tool's string-valued content without converting it to the renderer's typed `{ markdown }` material.

The adapter mapping defect was corrected after this capture and has focused regression coverage. That source/unit result does not replace a fresh production-client official-path rerun, so visible Markdown remains unproven by this ledger until the rerun is recorded.

## Final official OpenClaw rerun

The review-fixed packaged application was rebuilt and ad-hoc signed.

- `app.asar` SHA-256: `f544fae58cbf312181fd16adc3e092f9a409bd8a771c4a8e766ef4fb8706fe9a`.
- Executable SHA-256: `75b703bc93a0d46f3165c9e1f0ee1cca342cbaf9f5788ddc5f2ea52f57cd5781`.
- Proof root: `/tmp/t1770-final-proof.XZHsED`.
- Surface: `sf_2c2d8f9c502a`.
- Discovery fingerprint: `0acf563f`.
- Controller instance: `ci_2efbb03d5f46435ebc883bb83bdf52a7`.

An actual OpenClaw `codex/gpt-5.5` agent session used the official `surf_ace_list`, `surf_ace_push`, and `surf_ace_read` tools with three calls and zero failures. It pushed the exact Markdown text `T1770 final official OpenClaw proof`.

- Content ID: `ct_f05854dcea754a758ec90f7461b771ca`.
- History entry: `he_e45106539ae14aaa94bbff6bd68b7964`.
- Request: `rq_8924d8d254524e6aaeeba585daf49aae`.
- Client commit sequence: `5`.
- Agent trace: `/tmp/t1770-final-proof.XZHsED/openclaw-state/agents/main/agent/codex-home/sessions/2026/07/30/rollout-2026-07-30T16-38-26-019fb564-c0c3-7b20-bdf3-834142e0ac25.jsonl`, SHA-256 `37a045cfdb9baeff51af1ab3d04ebcec0dfdd93d73bd6b1d42317c3f887528b0`.

The tool output's `operationReceipt.clientResultIds.commitSequence` is `5`, matching the production client's accepted `content.set` audit. The official local read returned the same content ID and Markdown type with `cacheStatus=current`, one retained content record, no structured gap or loss, and an acknowledgement subsequently committed at sequence `6`.

The production DOM contained:

```html
<article class="content-markdown"><p>T1770 final official OpenClaw proof</p></article>
```

Chromium accessibility exposed matching static text, and the screenshot visibly confirms it. The final client log contains no `window_console_message`, `Uncaught`, or error match.

The actual session again supplied no friendly chat label, so the deterministic production fallback is `Unknown chat — Clawline`; exact `OpenClaw — Clawline` remains unproven. Its components retain `dir=auto` and isolated bidirectional rendering, and the noninteractive AX group exposes the full semantic name.

| Final artifact | SHA-256 |
|---|---|
| `final-dom.json` | `44bba2218abc86bf446e3a320cd93ca8706fb7720fcb33db58b5379204e6b021` |
| `final-ax.json` | `73b8aba23dc6325032ad72f264a3026a1cb61e34caa7bdacec8366322b73a091` |
| `final-visible.png` | `4fac825c84ba704afcbe71a743325cff0c656667da8cf45c6a08220bae9f79e5` |
| `client-flight-recorder.log` | `2a379aebd1e88a02ce0e91a88497b9ae5eb248f2ade1379348412169638468d2` |

The exact direct launch command and cleanup statement are recorded in `/tmp/t1770-final-proof.XZHsED/artifacts/launch-provenance.txt`. No launcher or persistence mechanism was used or changed.

The final independent review subsequently required topology-response, reclamation-disposition, and lifecycle-seam corrections. Those corrections passed the complete non-GUI suite and independent re-review but were not included in this packaged GUI artifact. This rerun therefore proves the corrected OpenClaw content/read/provenance path, not product readiness for the later combined source tree.

The visible composite provenance was `Unknown chat — Clawline`, because the official agent context supplied the provider product label but no friendly chat label. The pill was non-interactive, used isolated bidirectional components, retained its full accessible name, and occupied the composite width class. These provenance and accessibility observations remain valid, but they do not prove visible pushed content.

Back reached the prior entry and announced its full fallback provenance. Forward restored the official entry and announced `Pushed by Unknown chat, using Clawline`.

| Artifact | SHA-256 |
|---|---|
| `openclaw-dom.json` | `2007375d050b80ba0576bd7b06798a6cfb11ee69ff837a839e2617dd21b022b0` |
| `openclaw-ax.json` | `2fe4208184a0533f0c9c744e54959aace15352dbf3756ec77c11dd4883db8693` |
| `openclaw-visible.png` | `0afaa04f9d90cb7416f21abc2ee8db652b207965663d46f35d2b1e98542f3e7d` |
| `openclaw-back-announcement.json` | `2447ccc6e0ca0073397bd8315fc7a8d4dbf536669aa57de6ff66ae3339a34704` |
| `openclaw-forward-announcement.json` | `11c2e0985ffeb6b422d52ed23955ca7da28d534d024bc2ab5ccc007edd7122ba` |

## Official Tightbeam blocker

Evidence root: `/tmp/t1770-tightbeam-proof.slsOqh`.

The actual Claude Tightbeam session exposed all eleven official Surf Ace MCP tools, then received HTTP 429 for its weekly quota before its first tool call. The actual Codex Tightbeam session loaded the Surf Ace identity and skill but exposed no Surf Ace MCP tools. Consequently:

- no official Tightbeam mutation occurred;
- no Tightbeam mutation receipt can be correlated to a production-client audit;
- concurrent OpenClaw/Tightbeam admission and mutation remain unproven;
- diagnostic adapter, protocol, and compositor tests cannot replace this proof.

| Evidence | SHA-256 |
|---|---|
| `official-tool-declarations.json` | `e61b0707a989210d43b57affa6207a766eb031458a01472ca3ddaf12d15a4d36` |
| `claude-rate-limit-blocker.json` | `40d5aeb6c9c4069fb90f498dc52cfa5bbc6ed599e8645809820b3bcf87f57883` |
| `codex-mcp-exposure-blocker.json` | `734db3e61f08526c5482ff3c29b6eade7e771c8bf94eedc2eec8850c5101763c` |
| `client-authority-evidence.log` | `cded2e3027850ed20df5434d45663ab5ce6c411fa0803f545c00f3f21cc66f02` |

The evidence root includes `SHA256SUMS` for all retained request and transcript artifacts.

## Cleanup

The isolated Tightbeam gateway was stopped and its port `11977` released. The isolated OpenClaw gateway was stopped cleanly with `SIGINT` and its port `19171` released. The production Surf Ace client stopped cleanly at `2026-07-30T23:16:20Z` after the coordinated DOM, accessibility, screenshot, and navigation capture. Read-only process and listener checks found no Surf Ace process or launcher, DNS-SD helper, or listener on `65173` or `65174`.

No live surface/runtime was deployed, restarted, or mutated outside the isolated proof processes. No launchd, login-item, autostart, or persistence state was touched.
