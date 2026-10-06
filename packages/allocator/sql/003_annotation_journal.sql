-- Forward-only annotation journal schema. Apply to a stopped allocator after a
-- consistent backup of the primary and its synchronous witness.
BEGIN;
DO $preflight$
BEGIN
  IF to_regclass('surf_ace_allocator.fleets') IS NULL
     OR to_regclass('surf_ace_allocator.custody_journal') IS NULL THEN
    RAISE EXCEPTION 'allocator 001/002 state is required before annotation migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'surf_ace_allocator' AND table_name = 'fleets'
        AND column_name = 'next_pane_ordinal_fence') THEN
    RAISE EXCEPTION 'allocator pane state is required before annotation migration';
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.fleets WHERE lease_id IS NOT NULL) THEN
    RAISE EXCEPTION 'allocator lease must be released before annotation migration';
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.restore_generations
             WHERE state IN ('preparing', 'ready')) THEN
    RAISE EXCEPTION 'in-progress restore must settle before annotation migration';
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.fleets WHERE state_version <> 1) THEN
    RAISE EXCEPTION 'unsupported allocator state version';
  END IF;
END
$preflight$;

SET ROLE surf_ace_allocator_owner;
SET search_path = pg_catalog, surf_ace_allocator;

CREATE TABLE surf_ace_allocator.annotation_journal_head (
  fleet_id text PRIMARY KEY REFERENCES surf_ace_allocator.fleets(fleet_id),
  epoch text NOT NULL CHECK (epoch ~ '^[0-9a-f]{32}$'),
  head_sequence bigint NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  first_retained_sequence bigint CHECK (first_retained_sequence > 0),
  retained_record_count bigint NOT NULL DEFAULT 0 CHECK (retained_record_count >= 0),
  retained_canonical_bytes bigint NOT NULL DEFAULT 0 CHECK (retained_canonical_bytes >= 0),
  source_metadata_rows bigint NOT NULL DEFAULT 0 CHECK (source_metadata_rows >= 0),
  source_metadata_bytes bigint NOT NULL DEFAULT 0 CHECK (source_metadata_bytes >= 0),
  CHECK ((retained_record_count = 0 AND first_retained_sequence IS NULL)
    OR (retained_record_count = head_sequence - first_retained_sequence + 1))
);

CREATE TABLE surf_ace_allocator.annotation_journal_records (
  fleet_id text NOT NULL REFERENCES surf_ace_allocator.fleets(fleet_id),
  epoch text NOT NULL CHECK (epoch ~ '^[0-9a-f]{32}$'),
  sequence bigint NOT NULL CHECK (sequence > 0),
  client_id text NOT NULL,
  source_epoch text NOT NULL CHECK (source_epoch ~ '^[0-9a-f]{32}$'),
  surface_id text NOT NULL,
  source_sequence bigint NOT NULL CHECK (source_sequence > 0),
  source_event_id text NOT NULL,
  lost_from_sequence bigint CHECK (lost_from_sequence > 0 AND lost_from_sequence <= source_sequence),
  kind text NOT NULL CHECK (kind IN ('live_delta', 'frame_commit', 'source_gap')),
  canonical_record_bytes bytea NOT NULL,
  canonical_record_length integer NOT NULL CHECK (canonical_record_length > 0 AND canonical_record_length <= 16777216),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (fleet_id, epoch, sequence),
  UNIQUE (fleet_id, client_id, source_epoch, source_event_id),
  UNIQUE (fleet_id, client_id, source_epoch, surface_id, source_sequence),
  CHECK (octet_length(canonical_record_bytes) = canonical_record_length),
  CHECK ((kind = 'source_gap') = (lost_from_sequence IS NOT NULL))
);

CREATE TABLE surf_ace_allocator.annotation_source_receipts (
  fleet_id text NOT NULL REFERENCES surf_ace_allocator.fleets(fleet_id),
  client_id text NOT NULL,
  source_epoch text NOT NULL CHECK (source_epoch ~ '^[0-9a-f]{32}$'),
  surface_id text NOT NULL,
  source_sequence bigint NOT NULL CHECK (source_sequence > 0),
  source_event_id text NOT NULL,
  lost_from_sequence bigint CHECK (lost_from_sequence > 0 AND lost_from_sequence <= source_sequence),
  canonical_sha256 bytea NOT NULL CHECK (octet_length(canonical_sha256) = 32),
  canonical_length integer NOT NULL CHECK (canonical_length > 0 AND canonical_length <= 16777216),
  original_epoch text NOT NULL CHECK (original_epoch ~ '^[0-9a-f]{32}$'),
  original_sequence bigint NOT NULL CHECK (original_sequence > 0),
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (fleet_id, client_id, source_epoch, source_event_id),
  UNIQUE (fleet_id, client_id, source_epoch, surface_id, source_sequence),
  UNIQUE (fleet_id, original_epoch, original_sequence)
);

CREATE TABLE surf_ace_allocator.annotation_source_heads (
  fleet_id text NOT NULL REFERENCES surf_ace_allocator.fleets(fleet_id),
  client_id text NOT NULL,
  source_epoch text NOT NULL CHECK (source_epoch ~ '^[0-9a-f]{32}$'),
  surface_id text NOT NULL,
  accepted_through_sequence bigint NOT NULL CHECK (accepted_through_sequence > 0),
  PRIMARY KEY (fleet_id, client_id, source_epoch, surface_id)
);

CREATE TABLE surf_ace_allocator.annotation_consumers (
  fleet_id text NOT NULL REFERENCES surf_ace_allocator.fleets(fleet_id),
  consumer_id text NOT NULL CHECK (octet_length(consumer_id) BETWEEN 1 AND 128),
  initial_from_epoch text NOT NULL CHECK (initial_from_epoch ~ '^[0-9a-f]{32}$'),
  initial_from_sequence bigint NOT NULL CHECK (initial_from_sequence > 0),
  ack_epoch text CHECK (ack_epoch ~ '^[0-9a-f]{32}$'),
  ack_sequence bigint CHECK (ack_sequence >= 0),
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  current_lease_id text CHECK (current_lease_id ~ '^[0-9a-f]{32}$'),
  lease_connected boolean NOT NULL DEFAULT false,
  retired_at timestamptz,
  retired_expected_ack_cursor jsonb,
  retired_discarded_from_cursor jsonb,
  retired_discarded_through_cursor jsonb,
  PRIMARY KEY (fleet_id, consumer_id),
  CHECK ((ack_epoch IS NULL) = (ack_sequence IS NULL)),
  CHECK (NOT lease_connected OR (current_lease_id IS NOT NULL AND retired_at IS NULL))
);

INSERT INTO surf_ace_allocator.annotation_journal_head(fleet_id, epoch)
SELECT fleet_id, encode(gen_random_bytes(16), 'hex')
FROM surf_ace_allocator.fleets;

CREATE FUNCTION surf_ace_allocator.annotation_append(
  p_fleet_id text, p_generation bigint, p_lease_id text,
  p_client_id text, p_source_epoch text, p_surface_id text,
  p_source_sequence bigint, p_source_event_id text, p_lost_from_sequence bigint,
  p_kind text, p_canonical bytea
)
RETURNS TABLE(server_epoch text, server_sequence bigint, duplicate boolean, committed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  h surf_ace_allocator.annotation_journal_head%ROWTYPE;
  prior surf_ace_allocator.annotation_journal_records%ROWTYPE;
  receipt surf_ace_allocator.annotation_source_receipts%ROWTYPE;
  accepted bigint;
  new_head_bytes bigint;
  old_head_bytes bigint := 0;
  new_metadata_rows bigint;
  new_metadata_bytes bigint;
  canonical_digest bytea;
  appended_at timestamptz;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  IF p_canonical IS NULL OR octet_length(p_canonical) < 1 OR octet_length(p_canonical) > 16777216 THEN
    RAISE EXCEPTION 'annotation_record_too_large';
  END IF;
  SELECT * INTO STRICT h FROM surf_ace_allocator.annotation_journal_head
    WHERE fleet_id = p_fleet_id FOR UPDATE;
  SELECT * INTO prior FROM surf_ace_allocator.annotation_journal_records
    WHERE fleet_id = p_fleet_id AND client_id = p_client_id
      AND source_epoch = p_source_epoch AND source_event_id = p_source_event_id;
  IF FOUND THEN
    IF prior.canonical_record_bytes <> p_canonical THEN
      RAISE EXCEPTION 'annotation_source_event_conflict';
    END IF;
    RETURN QUERY SELECT prior.epoch, prior.sequence, true, prior.committed_at;
    RETURN;
  END IF;
  SELECT * INTO receipt FROM surf_ace_allocator.annotation_source_receipts
    WHERE fleet_id = p_fleet_id AND client_id = p_client_id
      AND source_epoch = p_source_epoch AND source_event_id = p_source_event_id;
  IF FOUND THEN
    canonical_digest := digest(p_canonical, 'sha256');
    IF receipt.canonical_length <> octet_length(p_canonical) OR receipt.canonical_sha256 <> canonical_digest THEN
      RAISE EXCEPTION 'annotation_source_event_conflict';
    END IF;
    RETURN QUERY SELECT receipt.original_epoch, receipt.original_sequence, true, receipt.committed_at;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.annotation_journal_records
      WHERE fleet_id = p_fleet_id AND client_id = p_client_id AND source_epoch = p_source_epoch
        AND surface_id = p_surface_id AND source_sequence = p_source_sequence)
     OR EXISTS (SELECT 1 FROM surf_ace_allocator.annotation_source_receipts
      WHERE fleet_id = p_fleet_id AND client_id = p_client_id AND source_epoch = p_source_epoch
        AND surface_id = p_surface_id AND source_sequence = p_source_sequence) THEN
    RAISE EXCEPTION 'annotation_source_sequence_conflict';
  END IF;
  SELECT accepted_through_sequence INTO accepted FROM surf_ace_allocator.annotation_source_heads
    WHERE fleet_id = p_fleet_id AND client_id = p_client_id AND source_epoch = p_source_epoch
      AND surface_id = p_surface_id;
  accepted := coalesce(accepted, 0);
  IF p_kind = 'source_gap' THEN
    IF p_lost_from_sequence IS NULL OR p_lost_from_sequence <> accepted + 1
       OR p_source_sequence < p_lost_from_sequence THEN
      RAISE EXCEPTION 'annotation_source_gap_invalid';
    END IF;
  ELSIF p_lost_from_sequence IS NOT NULL THEN
    RAISE EXCEPTION 'annotation_invalid_request';
  ELSIF p_source_sequence <= accepted THEN
    RAISE EXCEPTION 'annotation_source_sequence_conflict';
  ELSIF p_source_sequence <> accepted + 1 THEN
    RAISE EXCEPTION 'annotation_source_gap_required';
  END IF;
  IF h.head_sequence = 9223372036854775807 THEN
    RAISE EXCEPTION 'annotation_journal_sequence_exhausted';
  END IF;
  new_head_bytes := octet_length(convert_to(jsonb_build_object(
    'v', 1, 'clientId', p_client_id, 'sourceEpoch', p_source_epoch,
    'surfaceId', p_surface_id, 'acceptedThroughSequence', p_source_sequence::text)::text, 'utf8'));
  IF accepted > 0 THEN
    old_head_bytes := octet_length(convert_to(jsonb_build_object(
      'v', 1, 'clientId', p_client_id, 'sourceEpoch', p_source_epoch,
      'surfaceId', p_surface_id, 'acceptedThroughSequence', accepted::text)::text, 'utf8'));
  END IF;
  new_metadata_rows := h.source_metadata_rows + CASE WHEN accepted = 0 THEN 1 ELSE 0 END;
  new_metadata_bytes := h.source_metadata_bytes - old_head_bytes + new_head_bytes;
  IF h.retained_record_count >= 100000 OR new_metadata_rows > 1000000
     OR h.retained_canonical_bytes + octet_length(p_canonical) + new_metadata_bytes > 1073741824 THEN
    RAISE EXCEPTION 'annotation_ingest_capacity';
  END IF;
  INSERT INTO surf_ace_allocator.annotation_journal_records(
    fleet_id, epoch, sequence, client_id, source_epoch, surface_id,
    source_sequence, source_event_id, lost_from_sequence, kind,
    canonical_record_bytes, canonical_record_length)
  VALUES (p_fleet_id, h.epoch, h.head_sequence + 1, p_client_id, p_source_epoch,
    p_surface_id, p_source_sequence, p_source_event_id, p_lost_from_sequence,
    p_kind, p_canonical, octet_length(p_canonical))
  RETURNING annotation_journal_records.committed_at INTO appended_at;
  INSERT INTO surf_ace_allocator.annotation_source_heads(
    fleet_id, client_id, source_epoch, surface_id, accepted_through_sequence)
  VALUES (p_fleet_id, p_client_id, p_source_epoch, p_surface_id, p_source_sequence)
  ON CONFLICT (fleet_id, client_id, source_epoch, surface_id)
  DO UPDATE SET accepted_through_sequence = excluded.accepted_through_sequence;
  UPDATE surf_ace_allocator.annotation_journal_head SET
    head_sequence = h.head_sequence + 1,
    first_retained_sequence = coalesce(h.first_retained_sequence, h.head_sequence + 1),
    retained_record_count = h.retained_record_count + 1,
    retained_canonical_bytes = h.retained_canonical_bytes + octet_length(p_canonical),
    source_metadata_rows = new_metadata_rows,
    source_metadata_bytes = new_metadata_bytes
  WHERE fleet_id = p_fleet_id;
  RETURN QUERY SELECT h.epoch, h.head_sequence + 1, false, appended_at;
END
$function$;

GRANT EXECUTE ON FUNCTION surf_ace_allocator.annotation_append(
  text, bigint, text, text, text, text, bigint, text, bigint, text, bytea
) TO surf_ace_allocator_writer;

CREATE FUNCTION surf_ace_allocator.annotation_info(
  p_fleet_id text, p_generation bigint, p_lease_id text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  h surf_ace_allocator.annotation_journal_head%ROWTYPE;
  actual_count bigint;
  actual_bytes bigint;
  actual_min bigint;
  actual_max bigint;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  SELECT * INTO STRICT h FROM surf_ace_allocator.annotation_journal_head WHERE fleet_id = p_fleet_id;
  SELECT count(*), coalesce(sum(canonical_record_length), 0), min(sequence), max(sequence)
    INTO actual_count, actual_bytes, actual_min, actual_max
    FROM surf_ace_allocator.annotation_journal_records WHERE fleet_id = p_fleet_id;
  IF actual_count <> h.retained_record_count OR actual_bytes <> h.retained_canonical_bytes
     OR (actual_count > 0 AND (actual_min <> h.first_retained_sequence OR actual_max <> h.head_sequence))
     OR (actual_count = 0 AND h.first_retained_sequence IS NOT NULL) THEN
    RAISE EXCEPTION 'annotation_journal_unverified';
  END IF;
  RETURN jsonb_build_object(
    'epoch', h.epoch, 'headSequence', h.head_sequence::text,
    'firstRetainedSequence', h.first_retained_sequence::text,
    'journalRecords', h.retained_record_count,
    'journalCanonicalBytes', h.retained_canonical_bytes,
    'sourceMetadataRows', h.source_metadata_rows,
    'sourceMetadataBytes', h.source_metadata_bytes,
    'consumerSlots', (SELECT count(*) FROM surf_ace_allocator.annotation_consumers WHERE fleet_id = p_fleet_id),
    'activeStreams', (SELECT count(*) FROM surf_ace_allocator.annotation_consumers
      WHERE fleet_id = p_fleet_id AND lease_connected AND retired_at IS NULL)
  );
END
$function$;

GRANT EXECUTE ON FUNCTION surf_ace_allocator.annotation_info(text, bigint, text)
  TO surf_ace_allocator_writer;

RESET ROLE;
COMMIT;
