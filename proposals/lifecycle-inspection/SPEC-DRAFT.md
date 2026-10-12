# Read-only local lifecycle inspection — decision proposal

Status: **unapproved proposal**, assignment `asg_08c4a57a`, work item
`wi_4788a965`. This is not normative DESIGN text, an implemented capability,
permission for live inspection, or a reconciliation operation. It preserves
reviewed classifier `a5a127982fecbe69d17f4633bbff176d6417f946` unchanged.
Product packet `art_9b1fc02a` SHA256
`b3389682ad7a43adcb2a35cc8674ed2b7e47e0c6e92dbb1eed524ec97ccad244`
and clean classifier review `att_0ab5dd9e` are the basis.

## One separate-spec choice for Mike

**A, recommended:** approve a separate normative specification for the local
process-bound, same-UID, capability-authenticated read-only seam below. Approval
of this proposal does not authorize implementation, rollout, live invocation,
or cleanup. Each requires its own exact source/review/runtime authority.

**B:** retain paired-only access. Use only an already admitted controller and
the existing direct endpoint; no fresh pairing, reconstructed controller root,
capability exception, new pre-pair op or attempt to inspect through registry.
The particular ad/ae/af incident remains uninspectable with current retained
custody until authentic original controller provenance is recovered. Unknown
original requests remain unknown under either option. Do not bundle a mutation
choice into this decision. A later evidence receipt may justify proposing a
different operation, but never replay of an invented original close.

## Recommended transport and authentication

Initial scope is installed **desktop macOS** client. Linux parity requires its
own proven process-credential adapter; iOS/remote/tailnet use is out of scope.
No TCP, HTTP, WS, mDNS advertisement, abstract socket, privileged daemon, root
service, app auto-start, sidecar, registry endpoint or new remote trust route.

Future app-owned endpoint: pathname AF_UNIX/SOCK_STREAM at
`/tmp/sa-diag-<effectiveUid>/<processEpoch>/s`. Epoch is a newly generated
128-bit lowercase hex value per app process, not a reused PID or surface label.
Maximum pathname100 UTF-8 bytes. Parent and epoch directories0700, owner equals
non-root app effective UID; socket0600. Resolve components using directory
handles/no-follow checks and verify owner/type/mode at every component. Never
follow a symlink, overwrite a foreign endpoint, repair permissions, or remove
another process's directory. Any collision/ownership uncertainty disables this
capability. The only filesystem additions would be this separate ephemeral
diagnostic directory/socket/capability; no profile/selector/controller writes.
Creating those additions is future implementation authority, not this draft.

The app writes a cryptographically random256-bit per-process read-only
capability to `cap` beside the socket, exclusive create0600/no-follow. It is
not an existing pairing credential, is never placed in a command argument,
environment, generic log, response, artifact or discovery advertisement.
Authenticated request framing sends it separately from the safe JSON body;
compare constant-time, rotate only on process restart, zero buffers after use.
Server never accepts a capability for another epoch. Same-UID malicious code
can read same-UID private files; this proposal makes no security boundary
against that threat or root. Capability scopes read-only inspection only.

Caller must independently select an installed process and verify boot identity,
PID plus kernel process birth time, effective UID, executable/build SHA and
non-secret clientId. Connecting to a path is not server authentication: verify
kernel peer credentials/PID and process birth/build before sending capability,
then revalidate before accepting response. Server verifies peer UID/PID/birth
and boot identity at accept and before response; caller-supplied UID is never
authority. Both must be the same non-root effective UID. Missing/inaccessible
credentials, process replacement, exec/build change, or unavailable native
credential API refuses; no portable PID-only fallback.

macOS adapter candidate is kernel local peer credentials/PID/audit token plus
process start-time query, with race/exec revalidation. XNU declares these local
socket options and process birth fields; headers alone do not establish Node
access or prove the adapter. A separately reviewed native adapter and supported
OS qualification are mandatory before implementation admission.
Sources: [Apple XNU local socket definitions](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/un.h),
[Apple XNU process birth fields](https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/bsd/sys/proc_info.h).
Linux alternative uses verified connected AF_UNIX peer credentials plus
boot/process-start/exec revalidation, not caller assertions; see
[Linux unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html).

## Framing, bounds, requests and refusal

One connection, one request, one response, then orderly close. Four-byte
big-endian length-prefixed frames: authentication frame maximum256 bytes,
safe JSON request maximum8192 bytes, response maximum262144 bytes. No arbitrary
paths, commands, eval, raw content or wildcard surface selection. Duplicate
JSON keys, unknown properties, nonfinite numbers, invalid UTF-8, trailing frame,
oversized payload or ancillary file descriptors refuse before collection.
Parser must enforce these properties before object validation; the synthetic
object validator cannot detect duplicate keys discarded by JSON.parse.

JSON request exact keys: version1, op `lifecycle.inspect`, requestId, random
256-bit hex nonce, expectedServer, targets[], survivors[], priorRequests[],
deadlineMs. expectedServer exact uid/pid/birth/bootId/processEpoch/clientId/
buildSha256. Stable IDs bounded128 safe characters; combined targets+survivors
1..32, both nonempty, disjoint unique. Request scope explicitly includes p/z/aa
for this incident by their actual stable IDs, not friendly labels. No guessed
IDs, path traversal or all-surface request. priorRequests contains at most one
explicit {surfaceId,controllerId,requestId} per scoped surface, maximum32;
empty means original unknown, not permission to search/infer a close request.

Deadline1..2000ms measured from frame receipt on server monotonic clock,
including admission, queue and collection. No retry within a request or
automatic reconnect/replay. One collector in flight per process, maximum4
requests per UID in a sliding60-second interval; excess refuses immediately.
Nonce replay cache is volatile maximum4 entries for60seconds under the same
rate limit; expire entries then admit, never silently evict an unexpired nonce.
Requests do not allocate a controller, consume its cursor, acknowledge receipt,
advance history, repair persistence, refresh registry, or emit lifecycle events.

Refusals: unsupported, unauthorized, identity_changed, invalid_scope,
invalid_frame, capacity, deadline, collection_unavailable. Before authentication
return only a generic refusal and close; do not leak existence/client IDs.
Authenticated refusal may echo requestId/nonce and a bounded enum reason with
effect:none/replayAllowed:false. Never reinterpret timeout as not_committed.
The present validator's reasons are detailed fixture diagnostics, not yet a
public wire error vocabulary. Subsequent specification text must map them.

## Evidence response schema

Response exact keys: version1/requestId/nonce/server/effect:none/
replayAllowed:false/startedMono/endedMono/collection/surfaces. Monotonic values
are server-local elapsed milliseconds, never compared with remote clocks.
collection contains before/after {mutationSequence,surfaceSetRevision,
selectorGeneration SHA256} and status stable|non_atomic. `stable` claims only
unchanged client collection boundary, not atomic registry freshness or physical
pixels. No authoritative orphan/close-success classification is returned.

One row per exact scoped surface with native/core/accepted/registry/request/
tombstone observations. Observation is either `{status:unknown,reason,
observedMono}` or `{status:observed,source,observedMono,data}`. Each data field
is `{known:true,value}` or `{known:false,reason}`. Partial knowledge stays
partial; no default zero, synthetic epoch, guessed revision or copied causal
stamp. Reasons: not_supplied/not_retained/not_supported/not_observable/
original_unknown/controller_reclaimed/registry_unavailable/stale/non_atomic/
deadline. `validate.mjs` is the exact allowlisted draft field/type definition:

- native/owned_window_map: present and windowCount. Exhaustive app-owned map
  must be read on owning UI seam; accessible OS inventory alone is not this.
- core/serialized_core: state live|absent|tombstoned, epoch, topologyRevision,
  surfaceSetRevision, retainedFingerprint.
- accepted/selector_accepted_bytes: state, epoch, selectorPhase committed|pending,
  acceptedSha256, surfaceSetRevision/topologyRevision, retainedFingerprint.
  Hash exact selected bytes without loading/recovering/writing them; missing or
  invalid selector remains unknown. No backup promotion or temporary cleanup.
- registry/existing_registry_cache: state live|absent, clientId/processEpoch,
  surfaceSetRevision, acknowledgedSequence, receivedMono. Cache only; no new
  registry request, hello/register/claim/removal. Fields not present on existing
  wire are not_supported. Receipt time maximum1000ms for a fresh observation;
  old projection reports stale, not absent. Identity missing is not proof of
  correlation; collection stable never upgrades registry causal knowledge.
- request/retained_request_receipt: explicitly selected controllerId/requestId,
  originalFingerprint, outcome, commitSequence, resultFingerprint. Read only
  currently retained records; absent original envelope is original_unknown or
  not_retained even when receipt outcome is known. No resurrection/inference.
- tombstone/retained_surface_tombstone: tombstoneId/epoch/closedSequence/
  postSetRevision/retainedFingerprint. No retention extension or reclamation.

Fingerprints are per-inspection HMAC-SHA256 over a separately reviewed canonical
full retained graph, keyed with ephemeral random material held in memory only;
they permit comparisons within one response, not cross-request content tracking.
Canonicalization covers stable IDs, histories/visible entries/revisions,
annotations/restore state, lineage and session/cursor metadata without returning
those bytes. Equal graphs yield equal fingerprints across core/accepted/retained
views in the response. Hashing unavailable schema is unknown, not a partial
fingerprint labeled complete. Accepted-file SHA is exact raw-file SHA, distinct
from retainedFingerprint. The proposal validator checks shape, not authenticity
or graph normalization; canonicalizer needs independent tests before runtime.

## Collection and privacy contract

Admission acquires no mutation authority. Queue a bounded read barrier on the
existing client ordered seam; capture native map/core/receipt/tombstone snapshots
on their owning threads without waiting for network or altering state. Record
before process identity and mutation/set/selector boundary. Read exact selector
and accepted file bytes through stable file handles read-only. Re-read selector,
native generation, mutation/set revisions and process identity after all reads.
If changed, return non_atomic with affected observations marked non_atomic, or
refuse if identity/deadline cannot be established. Do not retry until stable,
block UI for disk I/O, or hold a mutation lock across filesystem/network waits.
Design must add a native-map generation to internal revalidation even though
public collection envelope uses a combined mutationSequence; proof that every
native/core change advances that combined sequence is a prerequisite, not an
assumption about current source. Failure to instrument it disables stable claim.

Cache registry observations separately with original local receipt timestamps
and actual available acknowledgement fields. They are not atomic with client
state. Changed process/build or unsupported epoch must remain unknown/refusal.
If collection finishes after deadline, discard partial reply and return bounded
deadline refusal; no successful response from expired work. Caller also refuses
response after local2s timeout and never automatically replays it.

No URLs, HTML/text, strokes, screenshots, content names, controller credentials,
pair claims, tokens, capability bytes, filesystem paths or raw original payloads
in response/generic logs. IDs and fingerprints are diagnostic metadata with
same-host UID access, not authentication or public fleet data. Generic logs may
contain request correlation, duration, count and refusal enum only; no capability,
nonce or response dump. No durable app audit/receipt/state writes. Volatile
request/nonce/rate metadata expires60s; response buffers zeroed after send/close.
Caller does not persist by default; explicit authorized evidence export may
save redacted response0600, default expiration24h, no auto-upload. Export authority
is separate; deleting authorized evidence remains its owner's decision.
Ephemeral diagnostic endpoint cleanup removes only own identity-bound files
after process exit; no stale-profile or registry cleanup. Unsupported cleanup
cannot justify deleting a foreign socket.

## Validator-backed qualification and later gates

Commands: `node proposals/lifecycle-inspection/validate.test.mjs` and unchanged
`node scripts/lifecycle/inspect-evidence.test.mjs`. Synthetic tests cover UID/PID
reuse/build/credential/capability/path permissions/symlinks, nonce/deadline/rate,
scope and request selection, mutation/pair ops, privacy/unknown fields, false
stable collection, stale registry and unavailable original request.
They create no socket/file capability, app, native peer credential provider,
collector, network connection or live inspection. `isolated_fixture` proofs
are test assertions; a real adapter must never accept them as client input.

After independent proposal review and Mike's one choice: separate approved
normative PR (no implementation bundled), then native/auth/parser/collector
implementation with process-reuse/exec/symlink/permission/race/timeout tests and
independent security/contract review, then separate bounded runtime authority.
No cleanup or orphan-transition operation is part of any of those read-only
steps. Unknown original request, current accepted histories, p/z/aa and unrelated
work remain preserved. The clean classifier is not a permission capability.
