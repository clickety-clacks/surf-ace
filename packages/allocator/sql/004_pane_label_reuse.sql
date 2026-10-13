-- Apply to a stopped fleet after 002_fleet_panes.sql, a verified backup, and
-- staged restore validation. Reuse is deliberately disabled by default.
BEGIN;
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.fleets WHERE lease_id IS NOT NULL) THEN
    RAISE EXCEPTION 'allocator lease must be released before pane-generation migration';
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.restore_generations
             WHERE state IN ('preparing', 'ready')) THEN
    RAISE EXCEPTION 'in-progress restore must settle before pane-generation migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM surf_ace_allocator.custody_journal
    WHERE event->>'type' = 'pane-claimed'
    GROUP BY fleet_id, event->>'paneLabel'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate historical pane label prevents generation migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM surf_ace_allocator.custody_journal
    WHERE event->>'type' = 'pane-claimed'
    GROUP BY fleet_id, event->>'clientId', event->>'surfaceId', event->>'lineageId'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ambiguous historical pane lineage prevents generation migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM surf_ace_allocator.fleets f
    WHERE f.next_pane_ordinal_fence - 1 <> (
      SELECT count(DISTINCT (j.event->>'paneLabel')::bigint)
      FROM surf_ace_allocator.custody_journal j
      WHERE j.fleet_id = f.fleet_id AND j.event->>'type' = 'pane-claimed'
    )
  ) THEN
    RAISE EXCEPTION 'unreconciled historical pane labels must remain reserved';
  END IF;
END
$preflight$;

ALTER TABLE surf_ace_allocator.fleets
  ADD COLUMN IF NOT EXISTS next_pane_allocation_generation_fence bigint NOT NULL DEFAULT 0
    CHECK (next_pane_allocation_generation_fence >= 0),
  ADD COLUMN IF NOT EXISTS pane_label_reuse_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pane_label_schema_version integer NOT NULL DEFAULT 0
    CHECK (pane_label_schema_version >= 0);
ALTER TABLE surf_ace_allocator.fleets
  ALTER COLUMN pane_label_schema_version SET DEFAULT 2;

SET ROLE surf_ace_allocator_owner;
SET search_path = pg_catalog, surf_ace_allocator;

CREATE OR REPLACE FUNCTION surf_ace_allocator.pane_journal_is_complete(p_fleet_id text)
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

-- Existing pane claims have no generation in their immutable event bytes. The
-- migration appends a separate owner-controlled binding without rewriting the
-- witnessed journal. These identities remain active and keep their labels.
DO $migrate_generations$
DECLARE
  fleet_row record;
  claim_row record;
  generation_value bigint;
BEGIN
  FOR fleet_row IN SELECT fleet_id, allocator_id, head_seq
    FROM surf_ace_allocator.fleets ORDER BY fleet_id FOR UPDATE
  LOOP
    IF NOT surf_ace_allocator.pane_journal_is_complete(fleet_row.fleet_id) THEN
      RAISE EXCEPTION 'incomplete pane journal prevents generation migration for %', fleet_row.fleet_id;
    END IF;
    SELECT coalesce(max((event->>'allocationGeneration')::bigint), 0)
      INTO generation_value
      FROM surf_ace_allocator.custody_journal
      WHERE fleet_id = fleet_row.fleet_id
        AND event->>'type' IN ('pane-claimed', 'pane-generation-migrated')
        AND event ? 'allocationGeneration';
    FOR claim_row IN
      SELECT head_seq, event
      FROM surf_ace_allocator.custody_journal claim
      WHERE fleet_id = fleet_row.fleet_id
        AND event->>'type' = 'pane-claimed'
        AND NOT (event ? 'allocationGeneration')
        AND NOT EXISTS (
          SELECT 1 FROM surf_ace_allocator.custody_journal migrated
          WHERE migrated.fleet_id = claim.fleet_id
            AND migrated.event->>'type' = 'pane-generation-migrated'
            AND migrated.event->>'sourceClaimHeadSeq' = claim.head_seq::text
        )
      ORDER BY head_seq
    LOOP
      generation_value := generation_value + 1;
      PERFORM * FROM surf_ace_allocator.append_event(fleet_row.fleet_id, jsonb_build_object(
        'allocatorId', fleet_row.allocator_id,
        'allocationGeneration', generation_value,
        'clientId', claim_row.event->>'clientId',
        'fleetId', fleet_row.fleet_id,
        'lineageId', claim_row.event->>'lineageId',
        'paneId', claim_row.event->>'paneId',
        'paneLabel', (claim_row.event->>'paneLabel')::bigint,
        'sourceClaimHeadSeq', claim_row.head_seq::text,
        'surfaceId', claim_row.event->>'surfaceId',
        'type', 'pane-generation-migrated'
      ));
    END LOOP;
    UPDATE surf_ace_allocator.fleets
      SET next_pane_allocation_generation_fence = greatest(
        next_pane_allocation_generation_fence, generation_value),
        pane_label_schema_version = 2,
        pane_label_reuse_enabled = false
      WHERE fleet_id = fleet_row.fleet_id;
  END LOOP;
END
$migrate_generations$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.pane_release_idempotency_key(
  p_fleet_id text, p_allocator_id text, p_client_id text, p_surface_id text,
  p_pane_id text, p_lineage_id text, p_pane_label bigint,
  p_allocation_generation bigint, p_tombstone_kind text, p_tombstone_id text,
  p_close_revision bigint, p_terminal_retirement_revision bigint
)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  SELECT encode(public.digest(convert_to(surf_ace_allocator.canonical_json(jsonb_build_object(
    'allocationGeneration', p_allocation_generation,
    'allocatorId', p_allocator_id,
    'clientId', p_client_id,
    'closeRevision', p_close_revision,
    'fleetId', p_fleet_id,
    'lineageId', p_lineage_id,
    'paneId', p_pane_id,
    'paneLabel', p_pane_label,
    'surfaceId', p_surface_id,
    'terminalRetirementRevision', p_terminal_retirement_revision,
    'tombstoneId', p_tombstone_id,
    'tombstoneKind', p_tombstone_kind
  )), 'UTF8'), 'sha256'), 'hex')
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.claim_pane(
  p_fleet_id text, p_generation bigint, p_lease_id text,
  p_client_id text, p_surface_id text, p_pane_id text, p_lineage_id text
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  prior jsonb;
  label bigint;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  IF p_client_id !~ '^[a-f0-9]{64}$' OR p_surface_id !~ '^sf_[A-Za-z0-9._:-]{3,64}$'
     OR p_pane_id !~ '^[A-Za-z0-9._:-]{1,64}$' OR p_lineage_id !~ '^pl_[A-Za-z0-9._:-]{3,128}$' THEN
    RAISE EXCEPTION 'invalid pane identity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.lifecycle <> 'active' THEN RAISE EXCEPTION 'fleet is not active' USING ERRCODE = '55000'; END IF;
  IF NOT surf_ace_allocator.pane_journal_is_complete(p_fleet_id) THEN
    RAISE EXCEPTION 'incomplete pane journal keeps labels reserved' USING ERRCODE = '55000';
  END IF;
  -- Any generation-unaware client can retain number-only references or backups.
  -- Close the gate even when its identity already has an active claim; those
  -- retries are still evidence that a legacy reader is present.
  IF fleet.pane_label_reuse_enabled THEN
    PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id,
      jsonb_build_object('allocatorId', fleet.allocator_id, 'fleetId', p_fleet_id,
        'enabled', false, 'reason', 'legacy-client-claim', 'type', 'pane-label-reuse-gate'));
    UPDATE surf_ace_allocator.fleets SET pane_label_reuse_enabled = false WHERE fleet_id = p_fleet_id;
  END IF;
  SELECT event INTO prior FROM surf_ace_allocator.custody_journal
    WHERE fleet_id = p_fleet_id AND event->>'type' = 'pane-claimed'
      AND event->>'clientId' = p_client_id AND event->>'surfaceId' = p_surface_id
      AND event->>'lineageId' = p_lineage_id ORDER BY head_seq LIMIT 1;
  IF FOUND THEN
    IF prior->>'paneId' IS DISTINCT FROM p_pane_id THEN
      RAISE EXCEPTION 'pane lineage is bound to another pane ID' USING ERRCODE = '23505';
    END IF;
    IF EXISTS (SELECT 1 FROM surf_ace_allocator.custody_journal r
      WHERE r.fleet_id = p_fleet_id AND r.event->>'type' = 'pane-released'
        AND r.event->>'clientId' = p_client_id AND r.event->>'surfaceId' = p_surface_id
        AND r.event->>'paneId' = p_pane_id AND r.event->>'lineageId' = p_lineage_id) THEN
      RAISE EXCEPTION 'terminally retired pane identity cannot be claimed' USING ERRCODE = '23505';
    END IF;
    RETURN (prior->>'paneLabel')::bigint;
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.event->>'type' = 'pane-claimed'
      AND j.event->>'clientId' = p_client_id AND j.event->>'surfaceId' = p_surface_id
      AND (j.event->>'paneId' = p_pane_id OR j.event->>'lineageId' = p_lineage_id)) THEN
    RAISE EXCEPTION 'pane identity conflicts with allocator history' USING ERRCODE = '23505';
  END IF;
  label := fleet.next_pane_ordinal_fence;
  IF label > 9007199254740991 THEN RAISE EXCEPTION 'pane ordinal exceeds safe integer range' USING ERRCODE = '22003'; END IF;
  UPDATE surf_ace_allocator.fleets SET next_pane_ordinal_fence = label + 1 WHERE fleet_id = p_fleet_id;
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'clientId', p_client_id, 'fleetId', p_fleet_id,
    'paneId', p_pane_id, 'lineageId', p_lineage_id, 'paneLabel', label,
    'surfaceId', p_surface_id, 'type', 'pane-claimed'
  ));
  RETURN label;
END
$function$;

CREATE FUNCTION surf_ace_allocator.claim_pane_generation(
  p_fleet_id text, p_generation bigint, p_lease_id text,
  p_client_id text, p_surface_id text, p_pane_id text, p_lineage_id text
)
RETURNS TABLE (pane_label bigint, allocation_generation bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  prior jsonb;
  prior_head_seq bigint;
  label bigint;
  generation_value bigint;
  blocked boolean;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  IF p_client_id !~ '^[a-f0-9]{64}$' OR p_surface_id !~ '^sf_[A-Za-z0-9._:-]{3,64}$'
     OR p_pane_id !~ '^[A-Za-z0-9._:-]{1,64}$' OR p_lineage_id !~ '^pl_[A-Za-z0-9._:-]{3,128}$' THEN
    RAISE EXCEPTION 'invalid pane identity' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.lifecycle <> 'active' THEN RAISE EXCEPTION 'fleet is not active' USING ERRCODE = '55000'; END IF;
  IF NOT surf_ace_allocator.pane_journal_is_complete(p_fleet_id) THEN
    RAISE EXCEPTION 'incomplete pane journal keeps labels reserved' USING ERRCODE = '55000';
  END IF;
  SELECT j.event, j.head_seq INTO prior, prior_head_seq
    FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.event->>'type' = 'pane-claimed'
      AND j.event->>'clientId' = p_client_id AND j.event->>'surfaceId' = p_surface_id
      AND j.event->>'lineageId' = p_lineage_id ORDER BY j.head_seq LIMIT 1;
  IF FOUND THEN
    IF prior->>'paneId' IS DISTINCT FROM p_pane_id THEN
      RAISE EXCEPTION 'pane lineage is bound to another pane ID' USING ERRCODE = '23505';
    END IF;
    generation_value := CASE WHEN prior ? 'allocationGeneration'
      THEN (prior->>'allocationGeneration')::bigint ELSE NULL END;
    IF generation_value IS NULL THEN
      SELECT (event->>'allocationGeneration')::bigint INTO generation_value
        FROM surf_ace_allocator.custody_journal
        WHERE fleet_id = p_fleet_id AND event->>'type' = 'pane-generation-migrated'
          AND event->>'sourceClaimHeadSeq' = prior_head_seq::text;
    END IF;
    IF generation_value IS NULL THEN
      RAISE EXCEPTION 'legacy pane claim requires owner-verified generation migration' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM surf_ace_allocator.custody_journal r
      WHERE r.fleet_id = p_fleet_id AND r.event->>'type' = 'pane-released'
        AND r.event->>'clientId' = p_client_id AND r.event->>'surfaceId' = p_surface_id
        AND r.event->>'paneId' = p_pane_id AND r.event->>'lineageId' = p_lineage_id
        AND (r.event->>'allocationGeneration')::bigint = generation_value) THEN
      RAISE EXCEPTION 'terminally retired pane identity cannot be claimed' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT (prior->>'paneLabel')::bigint, generation_value;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.event->>'type' = 'pane-claimed'
      AND j.event->>'clientId' = p_client_id AND j.event->>'surfaceId' = p_surface_id
      AND (j.event->>'paneId' = p_pane_id OR j.event->>'lineageId' = p_lineage_id)) THEN
    RAISE EXCEPTION 'pane identity conflicts with allocator history' USING ERRCODE = '23505';
  END IF;
  generation_value := fleet.next_pane_allocation_generation_fence + 1;
  IF generation_value > 9007199254740991 THEN
    RAISE EXCEPTION 'pane allocation generation exceeds safe integer range' USING ERRCODE = '22003';
  END IF;
  label := fleet.next_pane_ordinal_fence;
  IF fleet.pane_label_reuse_enabled THEN
    label := 1;
    LOOP
      EXIT WHEN label >= fleet.next_pane_ordinal_fence;
      SELECT EXISTS (
        SELECT 1 FROM surf_ace_allocator.custody_journal claim
        WHERE claim.fleet_id = p_fleet_id AND claim.event->>'type' = 'pane-claimed'
          AND (claim.event->>'paneLabel')::bigint = label
          AND NOT EXISTS (
            SELECT 1 FROM surf_ace_allocator.custody_journal release
            WHERE release.fleet_id = claim.fleet_id AND release.event->>'type' = 'pane-released'
              AND release.event->>'clientId' = claim.event->>'clientId'
              AND release.event->>'surfaceId' = claim.event->>'surfaceId'
              AND release.event->>'paneId' = claim.event->>'paneId'
              AND release.event->>'lineageId' = claim.event->>'lineageId'
              AND release.event->>'paneLabel' = claim.event->>'paneLabel'
              AND release.event->>'allocationGeneration' = coalesce(claim.event->>'allocationGeneration',
                (SELECT migrated.event->>'allocationGeneration'
                 FROM surf_ace_allocator.custody_journal migrated
                 WHERE migrated.fleet_id = claim.fleet_id
                   AND migrated.event->>'type' = 'pane-generation-migrated'
                   AND migrated.event->>'sourceClaimHeadSeq' = claim.head_seq::text LIMIT 1))
          )
      ) INTO blocked;
      EXIT WHEN NOT blocked;
      label := label + 1;
    END LOOP;
    IF label >= fleet.next_pane_ordinal_fence THEN label := fleet.next_pane_ordinal_fence; END IF;
  END IF;
  IF label > 9007199254740991 THEN RAISE EXCEPTION 'pane ordinal exceeds safe integer range' USING ERRCODE = '22003'; END IF;
  UPDATE surf_ace_allocator.fleets SET
    next_pane_ordinal_fence = greatest(next_pane_ordinal_fence, label + 1),
    next_pane_allocation_generation_fence = generation_value
  WHERE fleet_id = p_fleet_id;
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'allocationGeneration', generation_value,
    'clientId', p_client_id, 'fleetId', p_fleet_id,
    'paneId', p_pane_id, 'lineageId', p_lineage_id, 'paneLabel', label,
    'surfaceId', p_surface_id, 'type', 'pane-claimed'
  ));
  RETURN QUERY SELECT label, generation_value;
END
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.release_pane_generation(
  p_fleet_id text, p_generation bigint, p_lease_id text,
  p_client_id text, p_surface_id text, p_pane_id text, p_lineage_id text,
  p_pane_label bigint, p_allocation_generation bigint, p_tombstone_kind text,
  p_tombstone_id text, p_close_revision bigint, p_terminal_retirement_revision bigint
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  claim jsonb;
  claim_head_seq bigint;
  known_generation bigint;
  release_key text;
  prior_release jsonb;
  expected jsonb;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  IF p_client_id !~ '^[a-f0-9]{64}$' OR p_surface_id !~ '^sf_[A-Za-z0-9._:-]{3,64}$'
     OR p_pane_id !~ '^[A-Za-z0-9._:-]{1,64}$' OR p_lineage_id !~ '^pl_[A-Za-z0-9._:-]{3,128}$'
     OR p_pane_label < 1 OR p_allocation_generation < 1
     OR p_tombstone_kind NOT IN ('pane', 'surface')
     OR p_tombstone_id !~ '^[A-Za-z0-9._:-]{1,128}$'
     OR p_close_revision < 1 OR p_terminal_retirement_revision < 1 THEN
    RAISE EXCEPTION 'invalid pane release evidence' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.lifecycle <> 'active' THEN RAISE EXCEPTION 'fleet is not active' USING ERRCODE = '55000'; END IF;
  IF NOT surf_ace_allocator.pane_journal_is_complete(p_fleet_id) THEN
    RAISE EXCEPTION 'incomplete pane journal keeps labels reserved' USING ERRCODE = '55000';
  END IF;
  SELECT event, head_seq INTO claim, claim_head_seq
    FROM surf_ace_allocator.custody_journal
    WHERE fleet_id = p_fleet_id AND event->>'type' = 'pane-claimed'
      AND event->>'clientId' = p_client_id AND event->>'surfaceId' = p_surface_id
      AND event->>'paneId' = p_pane_id AND event->>'lineageId' = p_lineage_id
      AND (event->>'paneLabel')::bigint = p_pane_label
    ORDER BY head_seq LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'pane allocation is not in allocator history' USING ERRCODE = '23503'; END IF;
  known_generation := CASE WHEN claim ? 'allocationGeneration'
    THEN (claim->>'allocationGeneration')::bigint ELSE NULL END;
  IF known_generation IS NULL THEN
    SELECT (event->>'allocationGeneration')::bigint INTO known_generation
      FROM surf_ace_allocator.custody_journal
      WHERE fleet_id = p_fleet_id AND event->>'type' = 'pane-generation-migrated'
        AND event->>'sourceClaimHeadSeq' = claim_head_seq::text;
  END IF;
  IF known_generation IS DISTINCT FROM p_allocation_generation THEN
    RAISE EXCEPTION 'pane allocation generation does not match' USING ERRCODE = '23505';
  END IF;
  release_key := surf_ace_allocator.pane_release_idempotency_key(
    p_fleet_id, fleet.allocator_id, p_client_id, p_surface_id, p_pane_id, p_lineage_id,
    p_pane_label, p_allocation_generation, p_tombstone_kind, p_tombstone_id,
    p_close_revision, p_terminal_retirement_revision);
  expected := jsonb_build_object(
    'allocationGeneration', p_allocation_generation, 'allocatorId', fleet.allocator_id,
    'clientId', p_client_id, 'closeRevision', p_close_revision, 'fleetId', p_fleet_id,
    'idempotencyKey', release_key, 'lineageId', p_lineage_id, 'paneId', p_pane_id,
    'paneLabel', p_pane_label, 'surfaceId', p_surface_id,
    'terminalRetirementRevision', p_terminal_retirement_revision,
    'tombstoneId', p_tombstone_id, 'tombstoneKind', p_tombstone_kind,
    'type', 'pane-released');
  SELECT event INTO prior_release FROM surf_ace_allocator.custody_journal
    WHERE fleet_id = p_fleet_id AND event->>'type' = 'pane-released'
      AND event->>'clientId' = p_client_id AND event->>'surfaceId' = p_surface_id
      AND event->>'paneId' = p_pane_id AND event->>'lineageId' = p_lineage_id
      AND (event->>'allocationGeneration')::bigint = p_allocation_generation
    ORDER BY head_seq LIMIT 1;
  IF FOUND THEN
    IF prior_release IS DISTINCT FROM expected THEN
      RAISE EXCEPTION 'pane release identity already has different evidence' USING ERRCODE = '23505';
    END IF;
    RETURN true;
  END IF;
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, expected);
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.set_pane_label_reuse_ready(
  p_fleet_id text, p_compatibility jsonb
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  head record;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_owner');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.pane_label_schema_version <> 2 THEN
    RAISE EXCEPTION 'pane generation schema is not current' USING ERRCODE = '55000';
  END IF;
  IF p_compatibility IS DISTINCT FROM jsonb_build_object(
    'allocator', true, 'clients', true, 'backupReaders', true,
    'referenceResolvers', true, 'rollbackReaders', true) THEN
    RAISE EXCEPTION 'pane reuse requires all generation and retirement compatibility gates' USING ERRCODE = '55000';
  END IF;
  IF NOT surf_ace_allocator.pane_journal_is_complete(p_fleet_id) THEN
    RAISE EXCEPTION 'incomplete pane journal keeps labels reserved' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM surf_ace_allocator.custody_journal claim
    WHERE claim.fleet_id = p_fleet_id AND claim.event->>'type' = 'pane-claimed'
      AND NOT (claim.event ? 'allocationGeneration')
      AND NOT EXISTS (SELECT 1 FROM surf_ace_allocator.custody_journal migrated
        WHERE migrated.fleet_id = claim.fleet_id AND migrated.event->>'type' = 'pane-generation-migrated'
          AND migrated.event->>'sourceClaimHeadSeq' = claim.head_seq::text)
  ) THEN
    RAISE EXCEPTION 'unmigrated legacy pane claims keep reuse disabled' USING ERRCODE = '55000';
  END IF;
  IF NOT fleet.pane_label_reuse_enabled THEN
    SELECT * INTO head FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
      'allocatorId', fleet.allocator_id, 'compatibility', p_compatibility,
      'enabled', true, 'fleetId', p_fleet_id, 'type', 'pane-label-reuse-gate'));
    UPDATE surf_ace_allocator.fleets SET pane_label_reuse_enabled = true WHERE fleet_id = p_fleet_id;
  END IF;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.disable_pane_label_reuse(p_fleet_id text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_owner');
  IF p_reason IS NULL OR p_reason !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
    RAISE EXCEPTION 'invalid pane reuse disable reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.pane_label_schema_version <> 2 THEN
    RAISE EXCEPTION 'pane generation schema is not current' USING ERRCODE = '55000';
  END IF;
  IF fleet.pane_label_reuse_enabled THEN
    PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
      'allocatorId', fleet.allocator_id, 'enabled', false,
      'fleetId', p_fleet_id, 'reason', p_reason, 'type', 'pane-label-reuse-gate'));
    UPDATE surf_ace_allocator.fleets SET pane_label_reuse_enabled = false WHERE fleet_id = p_fleet_id;
  END IF;
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION surf_ace_allocator.pane_journal_is_complete(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.pane_release_idempotency_key(text, text, text, text, text, text, bigint, bigint, text, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.claim_pane_generation(text, bigint, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.release_pane_generation(text, bigint, text, text, text, text, text, bigint, bigint, text, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.set_pane_label_reuse_ready(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.disable_pane_label_reuse(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.pane_journal_is_complete(text)
  TO surf_ace_allocator_writer, surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.claim_pane_generation(text, bigint, text, text, text, text, text)
  TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.release_pane_generation(text, bigint, text, text, text, text, text, bigint, bigint, text, text, bigint, bigint)
  TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.set_pane_label_reuse_ready(text, jsonb),
  surf_ace_allocator.disable_pane_label_reuse(text, text)
  TO surf_ace_allocator_owner;

CREATE OR REPLACE FUNCTION surf_ace_allocator.project_pane_mappings(
  p_fleet_id text, p_head_seq bigint
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  WITH claims AS (
    SELECT claim.head_seq, claim.event,
      coalesce((claim.event->>'allocationGeneration')::bigint,
        (SELECT (migrated.event->>'allocationGeneration')::bigint
         FROM surf_ace_allocator.custody_journal migrated
         WHERE migrated.fleet_id = claim.fleet_id
           AND migrated.event->>'type' = 'pane-generation-migrated'
           AND migrated.event->>'sourceClaimHeadSeq' = claim.head_seq::text
         LIMIT 1)) AS allocation_generation
    FROM surf_ace_allocator.custody_journal claim
    WHERE claim.fleet_id = p_fleet_id AND claim.head_seq <= p_head_seq
      AND claim.event->>'type' = 'pane-claimed'
  ), active AS (
    SELECT c.* FROM claims c
    WHERE NOT EXISTS (
      SELECT 1 FROM surf_ace_allocator.custody_journal released
      WHERE released.fleet_id = p_fleet_id AND released.head_seq <= p_head_seq
        AND released.event->>'type' = 'pane-released'
        AND released.event->>'clientId' = c.event->>'clientId'
        AND released.event->>'surfaceId' = c.event->>'surfaceId'
        AND released.event->>'paneId' = c.event->>'paneId'
        AND released.event->>'lineageId' = c.event->>'lineageId'
        AND released.event->>'paneLabel' = c.event->>'paneLabel'
        AND (released.event->>'allocationGeneration')::bigint = c.allocation_generation
    )
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'allocationGeneration', allocation_generation,
    'clientId', event->>'clientId', 'lineageId', event->>'lineageId',
    'paneId', event->>'paneId', 'paneLabel', (event->>'paneLabel')::bigint,
    'surfaceId', event->>'surfaceId'
  ) ORDER BY (event->>'paneLabel')::bigint), '[]'::jsonb)
  FROM active
$function$;

CREATE OR REPLACE FUNCTION surf_ace_allocator.read_accepted_state(p_fleet_id text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
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
    'nextPaneAllocationGenerationFence', f.next_pane_allocation_generation_fence,
    'paneLabelReuseEnabled', f.pane_label_reuse_enabled,
    'paneMappings', surf_ace_allocator.project_pane_mappings(f.fleet_id, f.head_seq),
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
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  WITH reserved AS (
    SELECT j.event, j.head_seq FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq AND j.event->>'type' = 'reserved'
  ), latest AS (
    SELECT DISTINCT ON (j.event->>'transactionId') j.event->>'transactionId' AS transaction_id,
      j.event->>'type' AS status
    FROM surf_ace_allocator.custody_journal j
    WHERE j.fleet_id = p_fleet_id AND j.head_seq <= p_head_seq
      AND j.event->>'type' IN ('reserved', 'committed', 'burned')
    ORDER BY j.event->>'transactionId', j.head_seq DESC
  ), transactions AS (
    SELECT r.event->>'transactionId' AS transaction_id,
      r.event->>'authorityId' AS authority_id, r.event->>'ownerAnchorId' AS owner_anchor_id,
      r.event->>'surfaceId' AS surface_id, (r.event->>'ordinal')::bigint AS ordinal, l.status
    FROM reserved r JOIN latest l ON l.transaction_id = r.event->>'transactionId'
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
    'paneMappings', surf_ace_allocator.project_pane_mappings(p_fleet_id, p_head_seq),
    'authorityOwners', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'authorityId', o.authority_id, 'ownerAnchorId', o.owner_anchor_id) ORDER BY o.authority_id) FROM owners o), '[]'::jsonb),
    'transactions', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'transactionId', t.transaction_id, 'status', t.status, 'authorityId', t.authority_id,
      'ownerAnchorId', t.owner_anchor_id, 'surfaceId', t.surface_id, 'ordinal', t.ordinal)
      ORDER BY t.ordinal) FROM transactions t), '[]'::jsonb),
    'mappings', coalesce((SELECT jsonb_agg(jsonb_build_object(
      'authorityId', t.authority_id, 'ownerAnchorId', t.owner_anchor_id,
      'surfaceId', t.surface_id, 'ordinal', t.ordinal,
      'windowLabel', surf_ace_allocator.base26(t.ordinal)) ORDER BY t.ordinal)
      FROM transactions t WHERE t.status = 'committed'), '[]'::jsonb)
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
       'nextPaneAllocationGenerationFence', 'paneLabelReuseEnabled',
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
  IF restore.source_snapshot->>'headHash' IS DISTINCT FROM snapshot_projection->>'headHash'
     OR (restore.source_snapshot->>'nextOrdinalFence')::bigint IS DISTINCT FROM (snapshot_projection->>'nextOrdinalFence')::bigint
     OR (restore.source_snapshot->>'nextPaneOrdinalFence')::bigint IS DISTINCT FROM (snapshot_projection->>'nextPaneOrdinalFence')::bigint
     OR (restore.source_snapshot->>'nextPaneAllocationGenerationFence')::bigint
       IS DISTINCT FROM (snapshot_projection->>'nextPaneAllocationGenerationFence')::bigint
     OR restore.source_snapshot->'paneLabelReuseEnabled' IS DISTINCT FROM snapshot_projection->'paneLabelReuseEnabled'
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
      ON tx.generation_id = restore.generation_id AND tx.authority_id = mapping."authorityId"
      AND tx.surface_id = mapping."surfaceId" AND tx.ordinal = mapping.ordinal AND tx.status = 'committed';
  replayed_fence := (replay_projection->>'nextOrdinalFence')::bigint;
  SELECT * INTO appended FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'computedFence', replayed_fence,
    'fleetId', p_fleet_id, 'generationId', restore.generation_id, 'type', 'restore-ready'
  ));
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
     OR fleet.head_hash <> p_expected_head_hash
     OR restore.ready_head_seq <> fleet.head_seq OR restore.ready_head_hash <> fleet.head_hash
     OR fleet.accepted_generation_id <> restore.prior_generation_id THEN
    RAISE EXCEPTION 'restore activation precondition mismatch' USING ERRCODE = '55000';
  END IF;
  projection := surf_ace_allocator.journal_projection(p_fleet_id, restore.base_head_seq);
  UPDATE surf_ace_allocator.fleets SET
    accepted_generation_id = restore.generation_id,
    next_ordinal_fence = restore.computed_fence,
    next_pane_ordinal_fence = (projection->>'nextPaneOrdinalFence')::bigint,
    next_pane_allocation_generation_fence = (projection->>'nextPaneAllocationGenerationFence')::bigint,
    pane_label_reuse_enabled = (projection->>'paneLabelReuseEnabled')::boolean
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

REVOKE ALL ON FUNCTION surf_ace_allocator.project_pane_mappings(text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.journal_projection(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.project_pane_mappings(text, bigint)
  TO surf_ace_allocator_writer, surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.journal_projection(text, bigint)
  TO surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.claim_pane(text, bigint, text, text, text, text, text)
  TO surf_ace_allocator_writer;
RESET ROLE;
COMMIT;
