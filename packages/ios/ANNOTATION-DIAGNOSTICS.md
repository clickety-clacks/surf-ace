# Producer annotation diagnostics

These operational events describe the iOS durable producer, not consumer action completion. They carry no annotation payload, image, stroke data, credential, URL userinfo, path, query or fragment.

- `annotation_saved` is emitted after the local stroke authority transaction commits. Its durable frame identity (`client_id`, `source_epoch`, `surface_id`, `frame_id`) correlates the saved frame with later records. An event ID does not exist until a source record is queued.
- `annotation_queued` is emitted after the source outbox transaction commits. Its `source_event_id` and `source_sequence` come from that transaction's result, not a later snapshot. Overflow is correlated with the durable source gap identity. The timestamp records completion of local persistence, not original stroke time.
- `annotation_publisher_route` reports an explicit override/environment route or a verified registration selection. The endpoint is only scheme, host and port. Selection follows registry identity verification and durable registration application; it does not mean an annotation socket has connected.
- `annotation_publisher` stages are `route_selected`, `connected`, `sent`, `registry_accepted`, `acceptance_persisted` and `retry_scheduled`. `sent` means an exchange attempt; it does not prove delivery. `registry_accepted` means a valid durable-registry acceptance response arrived at the producer; its client timestamp is not the registry's receive timestamp. `acceptance_persisted` means the cursor/head acceptance has been committed locally. Retries preserve the same source event identity and canonical record.

Fields include UTC fractional-second `at`, source correlation, per-surface `outbox_depth`, connection readiness and bounded error/retry state. Publisher errors use stable codes rather than arbitrary error descriptions. A transport outage does not turn a frame into a source gap or imply a duplicate action.

Registry receive, agent start, action commit and processed ACK are separate owner stages and must propagate the same source identity/journal cursor. A producer acceptance is not an agent processed ACK. The old manually handled stroke is not synthesized into a new source event; real-device validation uses a new draw and Done through the existing consumer, without restarting it.
