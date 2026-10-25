BEGIN;
SET ROLE surf_ace_allocator_owner;
SET search_path = pg_catalog, surf_ace_allocator;

ALTER TABLE surf_ace_allocator.fleets
  ADD COLUMN IF NOT EXISTS window_label_reuse_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS window_label_schema_version integer NOT NULL DEFAULT 0
    CHECK (window_label_schema_version >= 0);

ALTER TABLE surf_ace_allocator.allocation_transactions
  DROP CONSTRAINT IF EXISTS allocation_transactions_fleet_id_allocator_id_generation_id_ordinal_key,
  DROP CONSTRAINT IF EXISTS allocation_transactions_status_check;
ALTER TABLE surf_ace_allocator.allocation_transactions
  ADD CONSTRAINT allocation_transactions_status_check
    CHECK (status IN ('reserved', 'burned', 'committed', 'released'));
CREATE UNIQUE INDEX IF NOT EXISTS allocation_transactions_active_ordinal_key
  ON surf_ace_allocator.allocation_transactions(fleet_id, allocator_id, generation_id, ordinal)
  WHERE status <> 'released';

UPDATE surf_ace_allocator.fleets SET window_label_schema_version = 2;
ALTER TABLE surf_ace_allocator.fleets
  ALTER COLUMN window_label_schema_version SET DEFAULT 2;

CREATE OR REPLACE FUNCTION surf_ace_allocator.window_journal_is_complete(p_fleet_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  SELECT f.head_seq = count(j.head_seq)
    AND (f.head_seq = 0 OR (min(j.head_seq) = 1 AND max(j.head_seq) = f.head_seq
      AND bool_or(j.head_seq = f.head_seq AND j.head_hash = f.head_hash)))
  FROM surf_ace_allocator.fleets f
  LEFT JOIN surf_ace_allocator.custody_journal j ON j.fleet_id = f.fleet_id
  WHERE f.fleet_id = p_fleet_id
  GROUP BY f.fleet_id, f.head_seq, f.head_hash
$function$;

CREATE FUNCTION surf_ace_allocator.window_release_idempotency_key(
  p_fleet_id text, p_allocator_id text, p_client_id text, p_surface_id text,
  p_window_label text, p_window_generation bigint, p_tombstone_id text,
  p_close_revision bigint, p_terminal_retirement_revision bigint
)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  SELECT encode(public.digest(convert_to(surf_ace_allocator.canonical_json(jsonb_build_object(
    'allocatorId', p_allocator_id,
    'clientId', p_client_id,
    'closeRevision', p_close_revision,
    'fleetId', p_fleet_id,
    'surfaceId', p_surface_id,
    'terminalRetirementRevision', p_terminal_retirement_revision,
    'tombstoneId', p_tombstone_id,
    'tombstoneKind', 'surface',
    'windowGeneration', p_window_generation,
    'windowLabel', p_window_label
  )), 'UTF8'), 'sha256'), 'hex')
$function$;

DROP FUNCTION surf_ace_allocator.reserve_ordinal(text, bigint, text, text, text, text, text);
CREATE FUNCTION surf_ace_allocator.reserve_ordinal(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_transaction_id text,
  p_authority_id text, p_owner_anchor_id text, p_surface_id text,
  p_window_generation_v1 boolean DEFAULT false
)
RETURNS TABLE (status text, ordinal bigint, window_label text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  tx surf_ace_allocator.allocation_transactions%ROWTYPE;
  assigned surf_ace_allocator.assignments%ROWTYPE;
  chosen_ordinal bigint;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.lifecycle <> 'active' THEN
    RAISE EXCEPTION 'fleet is not active' USING ERRCODE = '55000';
  END IF;
  IF NOT p_window_generation_v1 AND fleet.window_label_reuse_enabled THEN
    PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
      'allocatorId', fleet.allocator_id, 'enabled', false, 'fleetId', p_fleet_id,
      'reason', 'legacy-client-claim', 'type', 'window-label-reuse-gate'));
    UPDATE surf_ace_allocator.fleets SET window_label_reuse_enabled = false WHERE fleet_id = p_fleet_id;
    fleet.window_label_reuse_enabled := false;
  END IF;
  SELECT * INTO assigned FROM surf_ace_allocator.assignments
    WHERE fleet_id = p_fleet_id AND allocator_id = fleet.allocator_id
      AND generation_id = fleet.accepted_generation_id
      AND authority_id = p_authority_id AND surface_id = p_surface_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'committed'::text, assigned.ordinal, assigned.window_label;
    RETURN;
  END IF;
  SELECT * INTO tx FROM surf_ace_allocator.allocation_transactions
    WHERE transaction_id = p_transaction_id AND generation_id = fleet.accepted_generation_id;
  IF FOUND THEN
    IF tx.fleet_id <> p_fleet_id OR tx.authority_id <> p_authority_id
       OR tx.owner_anchor_id <> p_owner_anchor_id OR tx.surface_id <> p_surface_id THEN
      RAISE EXCEPTION 'transaction identity conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT tx.status, tx.ordinal,
      CASE WHEN tx.status = 'committed' THEN surf_ace_allocator.base26(tx.ordinal) ELSE NULL END;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM surf_ace_allocator.authority_owners
    WHERE fleet_id = p_fleet_id AND allocator_id = fleet.allocator_id
      AND generation_id = fleet.accepted_generation_id
      AND authority_id = p_authority_id AND owner_anchor_id = p_owner_anchor_id
  ) THEN
    RAISE EXCEPTION 'authority binding missing or conflicted' USING ERRCODE = '23503';
  END IF;
  IF EXISTS (
    WITH reservations AS (
      SELECT j.event->>'transactionId' AS transaction_id, j.event->>'authorityId' AS authority_id,
        j.event->>'surfaceId' AS surface_id
      FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = p_fleet_id AND j.event->>'type' = 'reserved'
    ), latest AS (
      SELECT DISTINCT ON (j.event->>'transactionId') j.event->>'transactionId' AS transaction_id,
        j.event->>'type' AS status
      FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = p_fleet_id AND j.event->>'type' IN ('reserved', 'committed', 'burned', 'window-released')
      ORDER BY j.event->>'transactionId', j.head_seq DESC
    )
    SELECT 1 FROM reservations r JOIN latest l USING (transaction_id)
    WHERE r.authority_id = p_authority_id AND r.surface_id = p_surface_id
      AND l.status IN ('committed', 'window-released')
  ) THEN
    RAISE EXCEPTION 'window identity is retired or lacks its active mapping' USING ERRCODE = '23505';
  END IF;
  IF fleet.window_label_reuse_enabled AND surf_ace_allocator.window_journal_is_complete(p_fleet_id) THEN
    WITH reservations AS (
      SELECT j.event->>'transactionId' AS transaction_id, (j.event->>'ordinal')::bigint AS ordinal
      FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = p_fleet_id AND j.event->>'type' = 'reserved'
    ), latest AS (
      SELECT DISTINCT ON (j.event->>'transactionId') j.event->>'transactionId' AS transaction_id,
        j.event->>'type' AS status
      FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = p_fleet_id
        AND j.event->>'type' IN ('reserved', 'committed', 'burned', 'window-released')
      ORDER BY j.event->>'transactionId', j.head_seq DESC
    ), occupied AS (
      SELECT DISTINCT r.ordinal FROM reservations r JOIN latest l USING (transaction_id)
      WHERE l.status <> 'window-released'
    ), candidates AS (
      SELECT 0::bigint AS ordinal
      UNION
      SELECT ordinal + 1 FROM occupied
    )
    SELECT min(c.ordinal) INTO chosen_ordinal FROM candidates c
      WHERE NOT EXISTS (SELECT 1 FROM occupied o WHERE o.ordinal = c.ordinal);
  ELSE
    chosen_ordinal := fleet.next_ordinal_fence;
  END IF;
  IF chosen_ordinal IS NULL OR chosen_ordinal < 0 OR chosen_ordinal >= 9007199254740991 THEN
    RAISE EXCEPTION 'window ordinal exceeds safe integer range' USING ERRCODE = '22003';
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.allocation_transactions t
    WHERE t.fleet_id = p_fleet_id AND t.allocator_id = fleet.allocator_id
      AND t.generation_id = fleet.accepted_generation_id AND t.ordinal = chosen_ordinal
      AND t.status <> 'released') THEN
    RAISE EXCEPTION 'window journal ambiguity keeps labels reserved' USING ERRCODE = '55000';
  END IF;
  INSERT INTO surf_ace_allocator.allocation_transactions(
    transaction_id, fleet_id, allocator_id, generation_id,
    authority_id, owner_anchor_id, surface_id, ordinal, status
  ) VALUES (
    p_transaction_id, p_fleet_id, fleet.allocator_id, fleet.accepted_generation_id,
    p_authority_id, p_owner_anchor_id, p_surface_id, chosen_ordinal, 'reserved'
  );
  UPDATE surf_ace_allocator.fleets
    SET next_ordinal_fence = greatest(next_ordinal_fence, chosen_ordinal + 1)
    WHERE fleet_id = p_fleet_id;
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'authorityId', p_authority_id,
    'fleetId', p_fleet_id, 'ordinal', chosen_ordinal,
    'ownerAnchorId', p_owner_anchor_id, 'surfaceId', p_surface_id,
    'transactionId', p_transaction_id, 'type', 'reserved'));
  RETURN QUERY SELECT 'reserved'::text, chosen_ordinal, NULL::text;
END
$function$;

DROP FUNCTION surf_ace_allocator.commit_mapping(text, bigint, text, text);
CREATE FUNCTION surf_ace_allocator.commit_mapping(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_transaction_id text
)
RETURNS TABLE (
  authority_id text, owner_anchor_id text, surface_id text,
  ordinal bigint, window_label text, recovered_at_custody_revision bigint,
  window_generation bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  tx surf_ace_allocator.allocation_transactions%ROWTYPE;
  label text;
  generation_value bigint;
  appended record;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  SELECT * INTO STRICT tx FROM surf_ace_allocator.allocation_transactions
    WHERE transaction_id = p_transaction_id AND generation_id = fleet.accepted_generation_id FOR UPDATE;
  IF tx.fleet_id <> p_fleet_id OR tx.allocator_id <> fleet.allocator_id
     OR tx.generation_id <> fleet.accepted_generation_id OR tx.status IN ('burned', 'released') THEN
    RAISE EXCEPTION 'transaction cannot commit' USING ERRCODE = '55000';
  END IF;
  label := surf_ace_allocator.base26(tx.ordinal);
  IF tx.status = 'reserved' THEN
    INSERT INTO surf_ace_allocator.assignments(
      fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id,
      surface_id, transaction_id, ordinal, window_label
    ) VALUES (
      tx.fleet_id, tx.allocator_id, tx.generation_id, tx.authority_id, tx.owner_anchor_id,
      tx.surface_id, tx.transaction_id, tx.ordinal, label
    );
    UPDATE surf_ace_allocator.allocation_transactions
      SET status = 'committed', updated_at = clock_timestamp()
      WHERE transaction_id = p_transaction_id AND generation_id = fleet.accepted_generation_id;
    SELECT * INTO appended FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
      'allocatorId', tx.allocator_id, 'authorityId', tx.authority_id,
      'fleetId', p_fleet_id, 'ordinal', tx.ordinal,
      'ownerAnchorId', tx.owner_anchor_id, 'surfaceId', tx.surface_id,
      'transactionId', p_transaction_id, 'type', 'committed', 'windowLabel', label));
    generation_value := appended.head_seq;
  ELSE
    SELECT j.head_seq INTO generation_value FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = p_fleet_id AND j.event->>'type' = 'committed'
        AND j.event->>'transactionId' = p_transaction_id
      ORDER BY j.head_seq LIMIT 1;
  END IF;
  IF generation_value IS NULL OR generation_value < 1 THEN
    RAISE EXCEPTION 'committed window generation is missing' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT tx.authority_id, tx.owner_anchor_id, tx.surface_id,
    tx.ordinal, label, NULL::bigint, generation_value;
END
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.window_label_reuse_ready(
  p_fleet_id text, p_compatibility jsonb
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  projection jsonb;
  accepted jsonb;
  accepted_mappings jsonb;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_owner');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.window_label_schema_version <> 2 THEN
    RAISE EXCEPTION 'window generation schema is not current' USING ERRCODE = '55000';
  END IF;
  IF p_compatibility IS DISTINCT FROM jsonb_build_object(
    'allocator', true, 'clients', true, 'backupReaders', true,
    'referenceResolvers', true, 'rollbackReaders', true) THEN
    RAISE EXCEPTION 'window reuse requires all generation and retirement compatibility gates' USING ERRCODE = '55000';
  END IF;
  IF NOT surf_ace_allocator.window_journal_is_complete(p_fleet_id) THEN
    RAISE EXCEPTION 'incomplete window journal keeps labels reserved' USING ERRCODE = '55000';
  END IF;
  projection := surf_ace_allocator.journal_projection(p_fleet_id, fleet.head_seq);
  accepted := surf_ace_allocator.read_accepted_state(p_fleet_id);
  SELECT coalesce(jsonb_agg(value - 'recoveredAtCustodyRevision'
    ORDER BY (value->>'ordinal')::bigint), '[]'::jsonb)
    INTO accepted_mappings FROM jsonb_array_elements(accepted->'mappings');
  IF accepted->'transactions' IS DISTINCT FROM projection->'transactions' OR
     accepted_mappings IS DISTINCT FROM projection->'mappings' OR
     accepted->'windowReleases' IS DISTINCT FROM projection->'windowReleases' THEN
    RAISE EXCEPTION 'window custody does not match its complete journal' USING ERRCODE = '55000';
  END IF;
  IF NOT fleet.window_label_reuse_enabled THEN
    PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
      'allocatorId', fleet.allocator_id, 'compatibility', p_compatibility,
      'enabled', true, 'fleetId', p_fleet_id, 'type', 'window-label-reuse-gate'));
    UPDATE surf_ace_allocator.fleets SET window_label_reuse_enabled = true WHERE fleet_id = p_fleet_id;
  END IF;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.release_window_generation(
  p_fleet_id text, p_generation bigint, p_lease_id text,
  p_client_id text, p_surface_id text, p_allocator_surface_id text,
  p_window_label text, p_window_generation bigint, p_tombstone_id text,
  p_close_revision bigint, p_terminal_retirement_revision bigint
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  tx surf_ace_allocator.allocation_transactions%ROWTYPE;
  assigned surf_ace_allocator.assignments%ROWTYPE;
  claim_generation bigint;
  release_key text;
  prior_release jsonb;
  expected jsonb;
  changed integer;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  IF p_client_id !~ '^[a-f0-9]{64}$' OR p_surface_id !~ '^sf_[A-Za-z0-9._:-]{3,64}$'
     OR p_allocator_surface_id !~ '^sf_[A-Za-z0-9._:-]{3,64}$'
     OR p_window_label !~ '^[a-z]+$' OR p_window_generation < 1
     OR p_tombstone_id !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_close_revision < 1 OR p_terminal_retirement_revision < 1 THEN
    RAISE EXCEPTION 'invalid window release evidence' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.lifecycle <> 'active' THEN RAISE EXCEPTION 'fleet is not active' USING ERRCODE = '55000'; END IF;
  IF NOT surf_ace_allocator.window_journal_is_complete(p_fleet_id) THEN
    RAISE EXCEPTION 'incomplete window journal keeps labels reserved' USING ERRCODE = '55000';
  END IF;
  release_key := surf_ace_allocator.window_release_idempotency_key(
    p_fleet_id, fleet.allocator_id, p_client_id, p_surface_id, p_window_label,
    p_window_generation, p_tombstone_id, p_close_revision, p_terminal_retirement_revision);
  SELECT j.event INTO prior_release FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.event->>'type' = 'window-released'
      AND j.event->>'allocatorSurfaceId' = p_allocator_surface_id
      AND (j.event->>'windowGeneration')::bigint = p_window_generation
    ORDER BY j.head_seq LIMIT 1;
  IF FOUND THEN
    IF prior_release->>'idempotencyKey' IS DISTINCT FROM release_key OR
       prior_release->>'clientId' IS DISTINCT FROM p_client_id OR
       prior_release->>'surfaceId' IS DISTINCT FROM p_surface_id OR
       prior_release->>'windowLabel' IS DISTINCT FROM p_window_label OR
       prior_release->>'tombstoneId' IS DISTINCT FROM p_tombstone_id OR
       prior_release->>'tombstoneKind' IS DISTINCT FROM 'surface' OR
       (prior_release->>'closeRevision')::bigint IS DISTINCT FROM p_close_revision OR
       (prior_release->>'terminalRetirementRevision')::bigint IS DISTINCT FROM p_terminal_retirement_revision THEN
      RAISE EXCEPTION 'window release identity already has different evidence' USING ERRCODE = '23505';
    END IF;
    RETURN true;
  END IF;
  SELECT a, t INTO assigned, tx FROM surf_ace_allocator.assignments a
    JOIN surf_ace_allocator.allocation_transactions t
      ON t.generation_id = a.generation_id AND t.transaction_id = a.transaction_id
    WHERE a.fleet_id = p_fleet_id AND a.allocator_id = fleet.allocator_id
      AND a.generation_id = fleet.accepted_generation_id
      AND a.surface_id = p_allocator_surface_id AND a.window_label = p_window_label
    FOR UPDATE OF a, t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'window allocation is not active' USING ERRCODE = '23503';
  END IF;
  SELECT j.head_seq INTO claim_generation FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.event->>'type' = 'committed'
      AND j.event->>'transactionId' = tx.transaction_id
    ORDER BY j.head_seq LIMIT 1;
  IF claim_generation IS DISTINCT FROM p_window_generation OR
     surf_ace_allocator.base26(assigned.ordinal) IS DISTINCT FROM p_window_label OR tx.status <> 'committed' THEN
    RAISE EXCEPTION 'window allocation generation does not match' USING ERRCODE = '23505';
  END IF;
  expected := jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'allocatorSurfaceId', p_allocator_surface_id,
    'authorityId', tx.authority_id, 'clientId', p_client_id,
    'closeRevision', p_close_revision, 'fleetId', p_fleet_id,
    'idempotencyKey', release_key, 'ordinal', assigned.ordinal,
    'ownerAnchorId', tx.owner_anchor_id, 'surfaceId', p_surface_id,
    'terminalRetirementRevision', p_terminal_retirement_revision,
    'tombstoneId', p_tombstone_id, 'tombstoneKind', 'surface',
    'transactionId', tx.transaction_id, 'type', 'window-released',
    'windowGeneration', p_window_generation, 'windowLabel', p_window_label);
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, expected);
  DELETE FROM surf_ace_allocator.assignments
    WHERE fleet_id = p_fleet_id AND allocator_id = fleet.allocator_id
      AND generation_id = fleet.accepted_generation_id AND transaction_id = tx.transaction_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'window assignment changed during release' USING ERRCODE = '40001'; END IF;
  UPDATE surf_ace_allocator.allocation_transactions
    SET status = 'released', updated_at = clock_timestamp()
    WHERE generation_id = fleet.accepted_generation_id AND transaction_id = tx.transaction_id
      AND status = 'committed';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'window transaction changed during release' USING ERRCODE = '40001'; END IF;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.read_accepted_state(p_fleet_id text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  SELECT jsonb_build_object(
    'fleetId', f.fleet_id, 'allocatorId', f.allocator_id, 'stateVersion', f.state_version,
    'lifecycle', f.lifecycle, 'acceptedGenerationId', f.accepted_generation_id,
    'custodyRevision', f.custody_revision, 'nextOrdinalFence', f.next_ordinal_fence,
    'nextPaneOrdinalFence', f.next_pane_ordinal_fence,
    'nextPaneAllocationGenerationFence', f.next_pane_allocation_generation_fence,
    'paneLabelReuseEnabled', f.pane_label_reuse_enabled,
    'windowLabelReuseEnabled', f.window_label_reuse_enabled,
    'paneMappings', surf_ace_allocator.project_pane_mappings(f.fleet_id, f.head_seq),
    'headSeq', f.head_seq, 'headHash', encode(f.head_hash, 'hex'),
    'leaseGeneration', f.lease_generation, 'leaseId', f.lease_id, 'leaseMode', f.lease_mode,
    'leaseBackendPid', f.lease_backend_pid, 'lastCommitAt', f.last_commit_at,
    'authorityOwners', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'authorityId', a.authority_id, 'ownerAnchorId', a.owner_anchor_id) ORDER BY a.authority_id)
      FROM surf_ace_allocator.authority_owners a
      WHERE a.fleet_id = f.fleet_id AND a.allocator_id = f.allocator_id
        AND a.generation_id = f.accepted_generation_id), '[]'::jsonb),
    'mappings', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'authorityId', a.authority_id, 'ownerAnchorId', a.owner_anchor_id,
      'surfaceId', a.surface_id, 'ordinal', a.ordinal, 'windowLabel', a.window_label,
      'windowGeneration', (SELECT j.head_seq FROM surf_ace_allocator.custody_journal j
        WHERE j.fleet_id = a.fleet_id AND j.event->>'type' = 'committed'
          AND j.event->>'transactionId' = a.transaction_id ORDER BY j.head_seq LIMIT 1),
      'recoveredAtCustodyRevision', a.recovered_at_custody_revision)
      ORDER BY a.ordinal) FROM surf_ace_allocator.assignments a
      WHERE a.fleet_id = f.fleet_id AND a.allocator_id = f.allocator_id
        AND a.generation_id = f.accepted_generation_id), '[]'::jsonb),
    'transactions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'transactionId', t.transaction_id, 'status', t.status,
      'authorityId', t.authority_id, 'ownerAnchorId', t.owner_anchor_id,
      'surfaceId', t.surface_id, 'ordinal', t.ordinal)
      ORDER BY t.ordinal, t.transaction_id) FROM surf_ace_allocator.allocation_transactions t
      WHERE t.fleet_id = f.fleet_id AND t.allocator_id = f.allocator_id
        AND t.generation_id = f.accepted_generation_id), '[]'::jsonb),
    'windowReleases', coalesce((SELECT jsonb_agg(j.event ORDER BY j.head_seq)
      FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = f.fleet_id AND j.event->>'type' = 'window-released'), '[]'::jsonb)
  ) FROM surf_ace_allocator.fleets f WHERE f.fleet_id = p_fleet_id
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.journal_projection(p_fleet_id text, p_head_seq bigint)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  WITH reserved AS (
    SELECT j.event, j.head_seq FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq AND j.event->>'type' = 'reserved'
  ), latest AS (
    SELECT DISTINCT ON (j.event->>'transactionId') j.event->>'transactionId' AS transaction_id,
      CASE WHEN j.event->>'type' = 'window-released' THEN 'released' ELSE j.event->>'type' END AS status
    FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq
      AND j.event->>'type' IN ('reserved', 'committed', 'burned', 'window-released')
    ORDER BY j.event->>'transactionId', j.head_seq DESC
  ), committed AS (
    SELECT j.event->>'transactionId' AS transaction_id, min(j.head_seq) AS window_generation
    FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq AND j.event->>'type' = 'committed'
    GROUP BY j.event->>'transactionId'
  ), transactions AS (
    SELECT r.event->>'transactionId' AS transaction_id,
      r.event->>'authorityId' AS authority_id, r.event->>'ownerAnchorId' AS owner_anchor_id,
      r.event->>'surfaceId' AS surface_id, (r.event->>'ordinal')::bigint AS ordinal,
      l.status, c.window_generation
    FROM reserved r JOIN latest l ON l.transaction_id = r.event->>'transactionId'
    LEFT JOIN committed c ON c.transaction_id = r.event->>'transactionId'
  ), owners AS (
    SELECT DISTINCT ON (j.event->>'authorityId')
      j.event->>'authorityId' AS authority_id, j.event->>'ownerAnchorId' AS owner_anchor_id
    FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq AND j.event->>'type' = 'authority-bound'
    ORDER BY j.event->>'authorityId', j.head_seq DESC
  )
  SELECT jsonb_build_object(
    'headSeq', p_head_seq,
    'headHash', CASE WHEN p_head_seq = 0 THEN repeat('00', 32)
      ELSE (SELECT encode(j.head_hash, 'hex') FROM surf_ace_allocator.custody_journal j
        WHERE j.fleet_id = p_fleet_id AND j.head_seq = p_head_seq) END,
    'nextOrdinalFence', coalesce((SELECT max(t.ordinal) + 1 FROM transactions t), 0),
    'nextPaneOrdinalFence', coalesce((SELECT max((j.event->>'paneLabel')::bigint) + 1
      FROM surf_ace_allocator.custody_journal j WHERE j.fleet_id = p_fleet_id
        AND j.head_seq <= p_head_seq AND j.event->>'type' = 'pane-claimed'), 1),
    'nextPaneAllocationGenerationFence', coalesce((SELECT max((j.event->>'allocationGeneration')::bigint)
      FROM surf_ace_allocator.custody_journal j WHERE j.fleet_id = p_fleet_id
        AND j.head_seq <= p_head_seq
        AND j.event->>'type' IN ('pane-claimed', 'pane-generation-migrated')
        AND j.event ? 'allocationGeneration'), 0),
    'paneLabelReuseEnabled', coalesce((SELECT (j.event->>'enabled')::boolean
      FROM surf_ace_allocator.custody_journal j WHERE j.fleet_id = p_fleet_id
        AND j.head_seq <= p_head_seq AND j.event->>'type' = 'pane-label-reuse-gate'
      ORDER BY j.head_seq DESC LIMIT 1), false),
    'windowLabelReuseEnabled', coalesce((SELECT (j.event->>'enabled')::boolean
      FROM surf_ace_allocator.custody_journal j WHERE j.fleet_id = p_fleet_id
        AND j.head_seq <= p_head_seq AND j.event->>'type' = 'window-label-reuse-gate'
      ORDER BY j.head_seq DESC LIMIT 1), false),
    'paneMappings', surf_ace_allocator.project_pane_mappings(p_fleet_id, p_head_seq),
    'authorityOwners', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'authorityId', o.authority_id, 'ownerAnchorId', o.owner_anchor_id) ORDER BY o.authority_id)
      FROM owners o), '[]'::jsonb),
    'transactions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'transactionId', t.transaction_id, 'status', t.status, 'authorityId', t.authority_id,
      'ownerAnchorId', t.owner_anchor_id, 'surfaceId', t.surface_id, 'ordinal', t.ordinal)
      ORDER BY t.ordinal, t.transaction_id) FROM transactions t), '[]'::jsonb),
    'mappings', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'authorityId', t.authority_id, 'ownerAnchorId', t.owner_anchor_id,
      'surfaceId', t.surface_id, 'ordinal', t.ordinal,
      'windowLabel', surf_ace_allocator.base26(t.ordinal),
      'windowGeneration', t.window_generation)
      ORDER BY t.ordinal) FROM transactions t WHERE t.status = 'committed'), '[]'::jsonb),
    'windowReleases', coalesce((SELECT jsonb_agg(j.event ORDER BY j.head_seq)
      FROM surf_ace_allocator.custody_journal j WHERE j.fleet_id = p_fleet_id
        AND j.head_seq <= p_head_seq AND j.event->>'type' = 'window-released'), '[]'::jsonb)
  )
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.mark_restore_ready(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_restore_generation_id text
)
RETURNS TABLE (ready_head_seq bigint, ready_head_hash text, computed_fence bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  restore surf_ace_allocator.restore_generations%ROWTYPE;
  snapshot_projection jsonb;
  replay_projection jsonb;
  snapshot_mappings jsonb;
  projected_mappings jsonb;
  legacy_snapshot_mappings jsonb;
  legacy_projected_mappings jsonb;
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
       'mappings', 'nextOrdinalFence', 'nextPaneOrdinalFence',
       'nextPaneAllocationGenerationFence', 'paneLabelReuseEnabled', 'windowLabelReuseEnabled',
       'paneMappings', 'stateVersion', 'transactions'
     ]::text[] <> '{}'::jsonb
     OR restore.source_snapshot->>'fleetId' IS DISTINCT FROM fleet.fleet_id
     OR restore.source_snapshot->>'allocatorId' IS DISTINCT FROM fleet.allocator_id
     OR (restore.source_snapshot->>'stateVersion')::integer IS DISTINCT FROM fleet.state_version
     OR (restore.source_snapshot->>'custodyRevision')::bigint IS DISTINCT FROM restore.snapshot_revision
     OR jsonb_typeof(restore.source_snapshot->'authorityOwners') IS DISTINCT FROM 'array'
     OR jsonb_typeof(restore.source_snapshot->'mappings') IS DISTINCT FROM 'array'
     OR jsonb_typeof(restore.source_snapshot->'paneMappings') IS DISTINCT FROM 'array'
     OR jsonb_typeof(restore.source_snapshot->'transactions') IS DISTINCT FROM 'array'
     OR jsonb_typeof(restore.source_snapshot->'paneLabelReuseEnabled') IS DISTINCT FROM 'boolean'
     OR (restore.source_snapshot ? 'windowLabelReuseEnabled' AND
       jsonb_typeof(restore.source_snapshot->'windowLabelReuseEnabled') IS DISTINCT FROM 'boolean')
     OR (restore.source_snapshot->>'nextPaneAllocationGenerationFence') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'restore snapshot shape or identity mismatch' USING ERRCODE = '55000';
  END IF;
  snapshot_seq := (restore.source_snapshot->>'headSeq')::bigint;
  IF snapshot_seq < 0 OR snapshot_seq > restore.base_head_seq THEN
    RAISE EXCEPTION 'restore snapshot head is not a prefix of the source journal' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM surf_ace_allocator.custody_revision_heads h
    WHERE h.fleet_id = p_fleet_id AND h.custody_revision = restore.snapshot_revision
      AND h.head_seq = snapshot_seq AND h.head_hash = decode(restore.source_snapshot->>'headHash', 'hex')
  ) THEN
    RAISE EXCEPTION 'restore snapshot revision is not bound to its journal head' USING ERRCODE = '55000';
  END IF;
  snapshot_projection := surf_ace_allocator.journal_projection(p_fleet_id, snapshot_seq);
  SELECT coalesce(jsonb_agg(value - 'recoveredAtCustodyRevision'
    ORDER BY (value->>'ordinal')::bigint), '[]'::jsonb)
    INTO snapshot_mappings FROM jsonb_array_elements(restore.source_snapshot->'mappings');
  projected_mappings := snapshot_projection->'mappings';
  SELECT coalesce(jsonb_agg(value - 'windowGeneration' - 'recoveredAtCustodyRevision'
    ORDER BY (value->>'ordinal')::bigint), '[]'::jsonb)
    INTO legacy_snapshot_mappings FROM jsonb_array_elements(restore.source_snapshot->'mappings');
  SELECT coalesce(jsonb_agg(value - 'windowGeneration' - 'recoveredAtCustodyRevision'
    ORDER BY (value->>'ordinal')::bigint), '[]'::jsonb)
    INTO legacy_projected_mappings FROM jsonb_array_elements(snapshot_projection->'mappings');
  IF restore.source_snapshot->>'headHash' IS DISTINCT FROM snapshot_projection->>'headHash'
     OR (restore.source_snapshot->>'nextOrdinalFence')::bigint IS DISTINCT FROM (snapshot_projection->>'nextOrdinalFence')::bigint
     OR (restore.source_snapshot->>'nextPaneOrdinalFence')::bigint IS DISTINCT FROM (snapshot_projection->>'nextPaneOrdinalFence')::bigint
     OR (restore.source_snapshot->>'nextPaneAllocationGenerationFence')::bigint
       IS DISTINCT FROM (snapshot_projection->>'nextPaneAllocationGenerationFence')::bigint
     OR restore.source_snapshot->'paneLabelReuseEnabled' IS DISTINCT FROM snapshot_projection->'paneLabelReuseEnabled'
     OR (restore.source_snapshot ? 'windowLabelReuseEnabled' AND
       restore.source_snapshot->'windowLabelReuseEnabled' IS DISTINCT FROM snapshot_projection->'windowLabelReuseEnabled')
     OR (NOT (restore.source_snapshot ? 'windowLabelReuseEnabled') AND
       (snapshot_projection->'windowLabelReuseEnabled')::text <> 'false')
     OR restore.source_snapshot->'paneMappings' IS DISTINCT FROM snapshot_projection->'paneMappings'
     OR restore.source_snapshot->'authorityOwners' IS DISTINCT FROM snapshot_projection->'authorityOwners'
     OR restore.source_snapshot->'transactions' IS DISTINCT FROM snapshot_projection->'transactions'
     OR (snapshot_mappings IS DISTINCT FROM projected_mappings AND
       ((snapshot_projection->'windowLabelReuseEnabled')::text <> 'false' OR
        jsonb_array_length(snapshot_projection->'windowReleases') > 0 OR
        legacy_snapshot_mappings IS DISTINCT FROM legacy_projected_mappings)) THEN
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
      ordinal bigint, "windowLabel" text, "windowGeneration" bigint
    ) JOIN surf_ace_allocator.allocation_transactions tx
      ON tx.generation_id = restore.generation_id AND tx.authority_id = mapping."authorityId"
      AND tx.surface_id = mapping."surfaceId" AND tx.ordinal = mapping.ordinal AND tx.status = 'committed';
  replayed_fence := (replay_projection->>'nextOrdinalFence')::bigint;
  SELECT * INTO appended FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'computedFence', replayed_fence,
    'fleetId', p_fleet_id, 'generationId', restore.generation_id, 'type', 'restore-ready'));
  UPDATE surf_ace_allocator.restore_generations SET state = 'ready',
    ready_head_seq = appended.head_seq, ready_head_hash = appended.head_hash, computed_fence = replayed_fence
    WHERE generation_id = restore.generation_id;
  RETURN QUERY SELECT appended.head_seq, encode(appended.head_hash, 'hex'), replayed_fence;
END
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.activate_restore(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_restore_generation_id text,
  p_expected_head_seq bigint, p_expected_head_hash bytea
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  restore surf_ace_allocator.restore_generations%ROWTYPE;
  projection jsonb;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_recovery');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'recovery');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  SELECT * INTO STRICT restore FROM surf_ace_allocator.restore_generations
    WHERE generation_id = p_restore_generation_id FOR UPDATE;
  IF restore.state = 'activated' THEN RETURN 'activated'; END IF;
  IF restore.state <> 'ready' OR fleet.head_seq <> p_expected_head_seq
     OR fleet.head_hash <> p_expected_head_hash OR restore.ready_head_seq <> fleet.head_seq
     OR restore.ready_head_hash <> fleet.head_hash
     OR fleet.accepted_generation_id <> restore.prior_generation_id THEN
    RAISE EXCEPTION 'restore activation precondition mismatch' USING ERRCODE = '55000';
  END IF;
  projection := surf_ace_allocator.journal_projection(p_fleet_id, restore.base_head_seq);
  UPDATE surf_ace_allocator.fleets SET
    accepted_generation_id = restore.generation_id,
    next_ordinal_fence = restore.computed_fence,
    next_pane_ordinal_fence = (projection->>'nextPaneOrdinalFence')::bigint,
    next_pane_allocation_generation_fence = (projection->>'nextPaneAllocationGenerationFence')::bigint,
    pane_label_reuse_enabled = (projection->>'paneLabelReuseEnabled')::boolean,
    window_label_reuse_enabled = (projection->>'windowLabelReuseEnabled')::boolean
    WHERE fleet_id = p_fleet_id;
  UPDATE surf_ace_allocator.restore_generations SET state = 'activated'
    WHERE generation_id = restore.generation_id;
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'fleetId', p_fleet_id,
    'generationId', restore.generation_id, 'type', 'restore-activated'));
  RETURN 'activated';
END
$function$;

REVOKE ALL ON FUNCTION surf_ace_allocator.window_journal_is_complete(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.window_release_idempotency_key(text, text, text, text, text, bigint, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.window_label_reuse_ready(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.release_window_generation(text, bigint, text, text, text, text, text, bigint, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.reserve_ordinal(text, bigint, text, text, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.commit_mapping(text, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.window_journal_is_complete(text)
  TO surf_ace_allocator_writer, surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.window_release_idempotency_key(text, text, text, text, text, bigint, text, bigint, bigint)
  TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.window_label_reuse_ready(text, jsonb)
  TO surf_ace_allocator_owner;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.release_window_generation(text, bigint, text, text, text, text, text, bigint, text, bigint, bigint)
  TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.reserve_ordinal(text, bigint, text, text, text, text, text, boolean)
  TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.commit_mapping(text, bigint, text, text)
  TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.journal_projection(text, bigint)
  TO surf_ace_allocator_recovery;

RESET ROLE;
COMMIT;
