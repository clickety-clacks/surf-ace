-- Apply only to a stopped v0.2.3 allocator after a verified base backup and
-- pg_dump of surf_ace_allocator. This migration preserves the journal head.
BEGIN;
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.fleets WHERE lease_id IS NOT NULL) THEN
    RAISE EXCEPTION 'allocator lease must be released before pane migration';
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.restore_generations
             WHERE state IN ('preparing', 'ready')) THEN
    RAISE EXCEPTION 'in-progress restore must settle before pane migration';
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.fleets WHERE state_version <> 1) THEN
    RAISE EXCEPTION 'unsupported allocator state version';
  END IF;
END
$preflight$;
ALTER TABLE surf_ace_allocator.fleets
  ADD COLUMN IF NOT EXISTS next_pane_ordinal_fence bigint NOT NULL DEFAULT 1
  CHECK (next_pane_ordinal_fence > 0);
SET ROLE surf_ace_allocator_owner;
SET search_path = pg_catalog, surf_ace_allocator;
CREATE OR REPLACE FUNCTION surf_ace_allocator.claim_pane(
  p_fleet_id text, p_generation bigint, p_lease_id text,
  p_client_id text, p_surface_id text, p_pane_id text, p_lineage_id text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  existing_label bigint;
  label bigint;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  IF p_client_id !~ '^[a-f0-9]{64}$'
     OR p_surface_id !~ '^sf_[A-Za-z0-9._:-]{3,64}$'
     OR p_pane_id !~ '^[A-Za-z0-9._:-]{1,64}$'
     OR p_lineage_id !~ '^pl_[A-Za-z0-9._:-]{3,128}$' THEN
    RAISE EXCEPTION 'invalid pane identity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets
    WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.lifecycle <> 'active' THEN
    RAISE EXCEPTION 'fleet is not active' USING ERRCODE = '55000';
  END IF;
  SELECT (event->>'paneLabel')::bigint INTO existing_label
    FROM surf_ace_allocator.custody_journal
    WHERE fleet_id = p_fleet_id AND event->>'type' = 'pane-claimed'
      AND event->>'clientId' = p_client_id
      AND event->>'surfaceId' = p_surface_id
      AND event->>'lineageId' = p_lineage_id
    LIMIT 1;
  IF FOUND THEN RETURN existing_label; END IF;
  label := fleet.next_pane_ordinal_fence;
  IF label > 9007199254740991 THEN
    RAISE EXCEPTION 'pane ordinal exceeds safe integer range' USING ERRCODE = '22003';
  END IF;
  UPDATE surf_ace_allocator.fleets
    SET next_pane_ordinal_fence = next_pane_ordinal_fence + 1
    WHERE fleet_id = p_fleet_id;
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id,
    'clientId', p_client_id,
    'fleetId', p_fleet_id,
    'paneId', p_pane_id,
    'lineageId', p_lineage_id,
    'paneLabel', label,
    'surfaceId', p_surface_id,
    'type', 'pane-claimed'
  ));
  RETURN label;
END
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.read_accepted_state(p_fleet_id text)
RETURNS jsonb
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  SELECT jsonb_build_object(
    'fleetId', f.fleet_id,
    'allocatorId', f.allocator_id,
    'stateVersion', f.state_version,
    'lifecycle', f.lifecycle,
    'acceptedGenerationId', f.accepted_generation_id,
    'custodyRevision', f.custody_revision,
    'nextOrdinalFence', f.next_ordinal_fence,
    'nextPaneOrdinalFence', f.next_pane_ordinal_fence,
    'paneMappings', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'clientId', j.event->>'clientId', 'surfaceId', j.event->>'surfaceId',
        'paneId', j.event->>'paneId', 'lineageId', j.event->>'lineageId',
        'paneLabel', (j.event->>'paneLabel')::bigint
      ) ORDER BY (j.event->>'paneLabel')::bigint)
      FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = f.fleet_id AND j.event->>'type' = 'pane-claimed'
    ), '[]'::jsonb),
    'headSeq', f.head_seq,
    'headHash', encode(f.head_hash, 'hex'),
    'leaseGeneration', f.lease_generation,
    'leaseId', f.lease_id,
    'leaseMode', f.lease_mode,
    'leaseBackendPid', f.lease_backend_pid,
    'lastCommitAt', f.last_commit_at,
    'authorityOwners', coalesce((
      SELECT jsonb_agg(jsonb_build_object('authorityId', a.authority_id, 'ownerAnchorId', a.owner_anchor_id) ORDER BY a.authority_id)
      FROM surf_ace_allocator.authority_owners a
      WHERE a.fleet_id = f.fleet_id AND a.allocator_id = f.allocator_id AND a.generation_id = f.accepted_generation_id
    ), '[]'::jsonb),
    'mappings', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'authorityId', a.authority_id, 'ownerAnchorId', a.owner_anchor_id,
        'surfaceId', a.surface_id, 'ordinal', a.ordinal,
        'windowLabel', a.window_label,
        'recoveredAtCustodyRevision', a.recovered_at_custody_revision
      ) ORDER BY a.ordinal)
      FROM surf_ace_allocator.assignments a
      WHERE a.fleet_id = f.fleet_id AND a.allocator_id = f.allocator_id AND a.generation_id = f.accepted_generation_id
    ), '[]'::jsonb),
    'transactions', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'transactionId', t.transaction_id, 'status', t.status,
        'authorityId', t.authority_id, 'ownerAnchorId', t.owner_anchor_id,
        'surfaceId', t.surface_id, 'ordinal', t.ordinal
      ) ORDER BY t.ordinal)
      FROM surf_ace_allocator.allocation_transactions t
      WHERE t.fleet_id = f.fleet_id AND t.allocator_id = f.allocator_id AND t.generation_id = f.accepted_generation_id
    ), '[]'::jsonb)
  )
  FROM surf_ace_allocator.fleets f WHERE f.fleet_id = p_fleet_id
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.journal_projection(p_fleet_id text, p_head_seq bigint)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  WITH reserved AS (
    SELECT j.event, j.head_seq
    FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq
      AND j.event->>'type' = 'reserved'
  ), latest AS (
    SELECT DISTINCT ON (j.event->>'transactionId')
      j.event->>'transactionId' AS transaction_id,
      j.event->>'type' AS status
    FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq
      AND j.event->>'type' IN ('reserved', 'committed', 'burned')
    ORDER BY j.event->>'transactionId', j.head_seq DESC
  ), transactions AS (
    SELECT r.event->>'transactionId' AS transaction_id,
      r.event->>'authorityId' AS authority_id,
      r.event->>'ownerAnchorId' AS owner_anchor_id,
      r.event->>'surfaceId' AS surface_id,
      (r.event->>'ordinal')::bigint AS ordinal,
      l.status
    FROM reserved r
    JOIN latest l ON l.transaction_id = r.event->>'transactionId'
  ), owners AS (
    SELECT DISTINCT ON (j.event->>'authorityId')
      j.event->>'authorityId' AS authority_id,
      j.event->>'ownerAnchorId' AS owner_anchor_id
    FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq
      AND j.event->>'type' = 'authority-bound'
    ORDER BY j.event->>'authorityId', j.head_seq DESC
  )
  SELECT jsonb_build_object(
    'headSeq', p_head_seq,
    'headHash', CASE WHEN p_head_seq = 0 THEN repeat('00', 32)
      ELSE (SELECT encode(j.head_hash, 'hex') FROM surf_ace_allocator.custody_journal j
        WHERE j.fleet_id = p_fleet_id AND j.head_seq = p_head_seq) END,
    'nextOrdinalFence', coalesce((SELECT max(t.ordinal) + 1 FROM transactions t), 0),
    'nextPaneOrdinalFence', coalesce((
      SELECT max((j.event->>'paneLabel')::bigint) + 1
      FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq
        AND j.event->>'type' = 'pane-claimed'
    ), 1),
    'paneMappings', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'clientId', j.event->>'clientId', 'surfaceId', j.event->>'surfaceId',
        'paneId', j.event->>'paneId', 'lineageId', j.event->>'lineageId',
        'paneLabel', (j.event->>'paneLabel')::bigint
      ) ORDER BY (j.event->>'paneLabel')::bigint)
      FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq
        AND j.event->>'type' = 'pane-claimed'
    ), '[]'::jsonb),
    'authorityOwners', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'authorityId', o.authority_id, 'ownerAnchorId', o.owner_anchor_id
    ) ORDER BY o.authority_id) FROM owners o), '[]'::jsonb),
    'transactions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'transactionId', t.transaction_id, 'status', t.status,
      'authorityId', t.authority_id, 'ownerAnchorId', t.owner_anchor_id,
      'surfaceId', t.surface_id, 'ordinal', t.ordinal
    ) ORDER BY t.ordinal) FROM transactions t), '[]'::jsonb),
    'mappings', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'authorityId', t.authority_id, 'ownerAnchorId', t.owner_anchor_id,
      'surfaceId', t.surface_id, 'ordinal', t.ordinal,
      'windowLabel', surf_ace_allocator.base26(t.ordinal)
    ) ORDER BY t.ordinal) FROM transactions t WHERE t.status = 'committed'), '[]'::jsonb)
  )
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.mark_restore_ready(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_restore_generation_id text
)
RETURNS TABLE (ready_head_seq bigint, ready_head_hash text, computed_fence bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  restore surf_ace_allocator.restore_generations%ROWTYPE;
  snapshot_projection jsonb;
  replay_projection jsonb;
  snapshot_mappings jsonb;
  snapshot_seq bigint;
  replayed_fence bigint;
  appended record;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_recovery');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'recovery');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  SELECT * INTO STRICT restore FROM surf_ace_allocator.restore_generations
    WHERE generation_id = p_restore_generation_id FOR UPDATE;
  IF restore.state = 'ready' THEN
    RETURN QUERY SELECT restore.ready_head_seq, encode(restore.ready_head_hash, 'hex'), restore.computed_fence;
    RETURN;
  END IF;
  IF restore.state <> 'preparing' OR restore.allocator_id <> fleet.allocator_id THEN
    RAISE EXCEPTION 'restore is not preparing for accepted allocator' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(restore.source_snapshot) IS DISTINCT FROM 'object'
     OR restore.source_snapshot - ARRAY[
       'allocatorId', 'authorityOwners', 'custodyRevision', 'fleetId', 'headHash', 'headSeq',
       'mappings', 'nextOrdinalFence', 'nextPaneOrdinalFence', 'paneMappings', 'stateVersion', 'transactions'
     ]::text[] <> '{}'::jsonb
     OR restore.source_snapshot->>'fleetId' IS DISTINCT FROM fleet.fleet_id
     OR restore.source_snapshot->>'allocatorId' IS DISTINCT FROM fleet.allocator_id
     OR (restore.source_snapshot->>'stateVersion')::integer IS DISTINCT FROM fleet.state_version
     OR (restore.source_snapshot->>'custodyRevision')::bigint IS DISTINCT FROM restore.snapshot_revision
     OR jsonb_typeof(restore.source_snapshot->'authorityOwners') IS DISTINCT FROM 'array'
     OR jsonb_typeof(restore.source_snapshot->'mappings') IS DISTINCT FROM 'array'
     OR jsonb_typeof(restore.source_snapshot->'paneMappings') IS DISTINCT FROM 'array'
     OR jsonb_typeof(restore.source_snapshot->'transactions') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'restore snapshot shape or identity mismatch' USING ERRCODE = '55000';
  END IF;
  snapshot_seq := (restore.source_snapshot->>'headSeq')::bigint;
  IF snapshot_seq < 0 OR snapshot_seq > restore.base_head_seq THEN
    RAISE EXCEPTION 'restore snapshot head is not a prefix of the source journal' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM surf_ace_allocator.custody_revision_heads h
    WHERE h.fleet_id = p_fleet_id
      AND h.custody_revision = restore.snapshot_revision
      AND h.head_seq = snapshot_seq
      AND h.head_hash = decode(restore.source_snapshot->>'headHash', 'hex')
  ) THEN
    RAISE EXCEPTION 'restore snapshot revision is not bound to its journal head' USING ERRCODE = '55000';
  END IF;
  snapshot_projection := surf_ace_allocator.journal_projection(p_fleet_id, snapshot_seq);
  SELECT coalesce(jsonb_agg(value - 'recoveredAtCustodyRevision'
    ORDER BY (value->>'ordinal')::bigint), '[]'::jsonb)
    INTO snapshot_mappings
    FROM jsonb_array_elements(restore.source_snapshot->'mappings');
  IF restore.source_snapshot->>'headHash' IS DISTINCT FROM snapshot_projection->>'headHash'
     OR (restore.source_snapshot->>'nextOrdinalFence')::bigint
       IS DISTINCT FROM (snapshot_projection->>'nextOrdinalFence')::bigint
     OR (restore.source_snapshot->>'nextPaneOrdinalFence')::bigint
       IS DISTINCT FROM (snapshot_projection->>'nextPaneOrdinalFence')::bigint
     OR restore.source_snapshot->'paneMappings' IS DISTINCT FROM snapshot_projection->'paneMappings'
     OR restore.source_snapshot->'authorityOwners' IS DISTINCT FROM snapshot_projection->'authorityOwners'
     OR restore.source_snapshot->'transactions' IS DISTINCT FROM snapshot_projection->'transactions'
     OR snapshot_mappings IS DISTINCT FROM snapshot_projection->'mappings' THEN
    RAISE EXCEPTION 'restore snapshot does not match its journal prefix' USING ERRCODE = '55000';
  END IF;
  replay_projection := surf_ace_allocator.journal_projection(p_fleet_id, restore.base_head_seq);
  IF replay_projection->>'headHash' IS DISTINCT FROM encode(restore.base_head_hash, 'hex') THEN
    RAISE EXCEPTION 'restore source journal does not end at its witnessed head' USING ERRCODE = '55000';
  END IF;
  INSERT INTO surf_ace_allocator.authority_owners(
    fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id
  ) SELECT fleet.fleet_id, fleet.allocator_id, restore.generation_id,
      owner."authorityId", owner."ownerAnchorId"
    FROM jsonb_to_recordset(replay_projection->'authorityOwners')
      AS owner("authorityId" text, "ownerAnchorId" text);
  INSERT INTO surf_ace_allocator.allocation_transactions(
    transaction_id, fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id,
    surface_id, ordinal, status
  ) SELECT tx."transactionId", fleet.fleet_id, fleet.allocator_id, restore.generation_id,
      tx."authorityId", tx."ownerAnchorId", tx."surfaceId", tx.ordinal, tx.status
    FROM jsonb_to_recordset(replay_projection->'transactions') AS tx(
      "transactionId" text, status text, "authorityId" text,
      "ownerAnchorId" text, "surfaceId" text, ordinal bigint
    );
  INSERT INTO surf_ace_allocator.assignments(
    fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id, surface_id,
    transaction_id, ordinal, window_label, recovered_at_custody_revision
  ) SELECT fleet.fleet_id, fleet.allocator_id, restore.generation_id,
      mapping."authorityId", mapping."ownerAnchorId", mapping."surfaceId",
      tx.transaction_id, mapping.ordinal, mapping."windowLabel", fleet.custody_revision + 1
    FROM jsonb_to_recordset(replay_projection->'mappings') AS mapping(
      "authorityId" text, "ownerAnchorId" text, "surfaceId" text,
      ordinal bigint, "windowLabel" text
    )
    JOIN surf_ace_allocator.allocation_transactions tx
      ON tx.generation_id = restore.generation_id
      AND tx.authority_id = mapping."authorityId"
      AND tx.surface_id = mapping."surfaceId"
      AND tx.ordinal = mapping.ordinal
      AND tx.status = 'committed';
  replayed_fence := (replay_projection->>'nextOrdinalFence')::bigint;
  SELECT * INTO appended FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'computedFence', replayed_fence,
    'fleetId', p_fleet_id, 'generationId', restore.generation_id,
    'type', 'restore-ready'
  ));
  UPDATE surf_ace_allocator.restore_generations SET
    state = 'ready', ready_head_seq = appended.head_seq,
    ready_head_hash = appended.head_hash, computed_fence = replayed_fence
  WHERE generation_id = restore.generation_id;
  RETURN QUERY SELECT appended.head_seq, encode(appended.head_hash, 'hex'), replayed_fence;
END
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.activate_restore(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_restore_generation_id text,
  p_expected_head_seq bigint, p_expected_head_hash bytea
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  restore surf_ace_allocator.restore_generations%ROWTYPE;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_recovery');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'recovery');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  SELECT * INTO STRICT restore FROM surf_ace_allocator.restore_generations
    WHERE generation_id = p_restore_generation_id FOR UPDATE;
  IF restore.state = 'activated' THEN RETURN 'activated'; END IF;
  IF restore.state <> 'ready' OR fleet.head_seq <> p_expected_head_seq
     OR fleet.head_hash <> p_expected_head_hash
     OR restore.ready_head_seq <> fleet.head_seq OR restore.ready_head_hash <> fleet.head_hash
     OR fleet.accepted_generation_id <> restore.prior_generation_id THEN
    RAISE EXCEPTION 'restore activation precondition mismatch' USING ERRCODE = '55000';
  END IF;
  UPDATE surf_ace_allocator.fleets SET
    accepted_generation_id = restore.generation_id,
    next_ordinal_fence = restore.computed_fence,
    next_pane_ordinal_fence = (surf_ace_allocator.journal_projection(p_fleet_id, restore.base_head_seq)->>'nextPaneOrdinalFence')::bigint
  WHERE fleet_id = p_fleet_id;
  UPDATE surf_ace_allocator.restore_generations SET state = 'activated'
    WHERE generation_id = restore.generation_id;
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'fleetId', p_fleet_id,
    'generationId', restore.generation_id, 'type', 'restore-activated'
  ));
  RETURN 'activated';
END
$function$;
RESET ROLE;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.claim_pane(text, bigint, text, text, text, text, text)
  TO surf_ace_allocator_writer;
COMMIT;
