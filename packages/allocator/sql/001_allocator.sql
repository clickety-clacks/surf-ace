CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'surf_ace_allocator_owner') THEN
    CREATE ROLE surf_ace_allocator_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'surf_ace_allocator_writer') THEN
    CREATE ROLE surf_ace_allocator_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'surf_ace_allocator_recovery') THEN
    CREATE ROLE surf_ace_allocator_recovery NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'surf_ace_allocator_witness') THEN
    CREATE ROLE surf_ace_allocator_witness NOLOGIN;
  END IF;
END
$roles$;

GRANT pg_signal_backend TO surf_ace_allocator_owner;
GRANT pg_read_all_stats TO surf_ace_allocator_owner, surf_ace_allocator_writer, surf_ace_allocator_recovery;

DO $grant_connect$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO surf_ace_allocator_writer, surf_ace_allocator_recovery, surf_ace_allocator_witness',
    current_database()
  );
END
$grant_connect$;

CREATE SCHEMA surf_ace_allocator AUTHORIZATION surf_ace_allocator_owner;
REVOKE ALL ON SCHEMA surf_ace_allocator FROM PUBLIC;
GRANT USAGE ON SCHEMA surf_ace_allocator TO
  surf_ace_allocator_writer,
  surf_ace_allocator_recovery,
  surf_ace_allocator_witness;

SET ROLE surf_ace_allocator_owner;
SET search_path = pg_catalog, surf_ace_allocator;

CREATE TABLE surf_ace_allocator.fleet_tombstones (
  fleet_id text PRIMARY KEY CHECK (fleet_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  first_allocator_id text NOT NULL,
  first_initialized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE surf_ace_allocator.fleets (
  fleet_id text PRIMARY KEY REFERENCES surf_ace_allocator.fleet_tombstones(fleet_id),
  allocator_id text NOT NULL UNIQUE CHECK (allocator_id ~ '^alloc_[A-Za-z0-9._:-]{3,64}$'),
  state_version integer NOT NULL CHECK (state_version > 0),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'destroyed')),
  accepted_generation_id text NOT NULL,
  custody_revision bigint NOT NULL DEFAULT 0 CHECK (custody_revision >= 0),
  next_ordinal_fence bigint NOT NULL DEFAULT 0 CHECK (next_ordinal_fence >= 0),
  head_seq bigint NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
  head_hash bytea NOT NULL DEFAULT decode(repeat('00', 32), 'hex') CHECK (octet_length(head_hash) = 32),
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_id text,
  lease_mode text CHECK (lease_mode IN ('writer', 'recovery')),
  lease_backend_pid integer,
  last_commit_at timestamptz,
  CHECK ((lease_id IS NULL AND lease_mode IS NULL AND lease_backend_pid IS NULL)
    OR (lease_id ~ '^lease_[A-Za-z0-9_-]{22}$' AND lease_mode IS NOT NULL AND lease_backend_pid IS NOT NULL))
);

CREATE TABLE surf_ace_allocator.authority_owners (
  fleet_id text NOT NULL,
  allocator_id text NOT NULL,
  generation_id text NOT NULL,
  authority_id text NOT NULL CHECK (authority_id ~ '^auth_[A-Za-z0-9._:-]{22,64}$'),
  owner_anchor_id text NOT NULL CHECK (owner_anchor_id ~ '^owner_[A-Za-z0-9._:-]{22,64}$'),
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (fleet_id, allocator_id, generation_id, authority_id),
  UNIQUE (fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id),
  FOREIGN KEY (fleet_id) REFERENCES surf_ace_allocator.fleets(fleet_id)
);

CREATE TABLE surf_ace_allocator.allocation_transactions (
  transaction_id text NOT NULL,
  fleet_id text NOT NULL,
  allocator_id text NOT NULL,
  generation_id text NOT NULL,
  authority_id text NOT NULL,
  owner_anchor_id text NOT NULL,
  surface_id text NOT NULL CHECK (surface_id ~ '^sf_[A-Za-z0-9._:-]{3,64}$'),
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  status text NOT NULL CHECK (status IN ('reserved', 'burned', 'committed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (generation_id, transaction_id),
  UNIQUE (fleet_id, allocator_id, generation_id, ordinal),
  FOREIGN KEY (fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id)
    REFERENCES surf_ace_allocator.authority_owners(fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id)
);

CREATE TABLE surf_ace_allocator.assignments (
  fleet_id text NOT NULL,
  allocator_id text NOT NULL,
  generation_id text NOT NULL,
  authority_id text NOT NULL,
  owner_anchor_id text NOT NULL,
  surface_id text NOT NULL,
  transaction_id text NOT NULL,
  ordinal bigint NOT NULL CHECK (ordinal >= 0),
  window_label text NOT NULL CHECK (window_label ~ '^[a-z]+$'),
  recovered_at_custody_revision bigint,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (fleet_id, allocator_id, generation_id, authority_id, surface_id),
  UNIQUE (fleet_id, allocator_id, generation_id, ordinal),
  UNIQUE (fleet_id, allocator_id, generation_id, window_label),
  FOREIGN KEY (generation_id, transaction_id)
    REFERENCES surf_ace_allocator.allocation_transactions(generation_id, transaction_id),
  FOREIGN KEY (fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id)
    REFERENCES surf_ace_allocator.authority_owners(fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id)
);

CREATE TABLE surf_ace_allocator.custody_journal (
  fleet_id text NOT NULL REFERENCES surf_ace_allocator.fleets(fleet_id),
  allocator_id text NOT NULL,
  head_seq bigint NOT NULL,
  previous_head_hash bytea NOT NULL CHECK (octet_length(previous_head_hash) = 32),
  event_bytes bytea NOT NULL,
  event jsonb NOT NULL,
  head_hash bytea NOT NULL CHECK (octet_length(head_hash) = 32),
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (fleet_id, head_seq),
  UNIQUE (fleet_id, head_hash)
);

CREATE TABLE surf_ace_allocator.restore_generations (
  generation_id text PRIMARY KEY,
  fleet_id text NOT NULL REFERENCES surf_ace_allocator.fleets(fleet_id),
  allocator_id text NOT NULL,
  idempotency_id text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('preparing', 'ready', 'activated', 'discarded')),
  source_snapshot jsonb NOT NULL,
  base_head_seq bigint NOT NULL,
  base_head_hash bytea NOT NULL CHECK (octet_length(base_head_hash) = 32),
  ready_head_seq bigint,
  ready_head_hash bytea,
  computed_fence bigint,
  prior_generation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION surf_ace_allocator.advisory_keys(p_fleet_id text)
RETURNS TABLE (key1 integer, key2 integer)
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  WITH bytes AS (
    SELECT public.digest(convert_to('surf-ace-window-label:' || p_fleet_id, 'UTF8'), 'sha256') AS value
  ), words AS (
    SELECT
      get_byte(value, 0)::bigint * 16777216 + get_byte(value, 1)::bigint * 65536 + get_byte(value, 2)::bigint * 256 + get_byte(value, 3) AS word1,
      get_byte(value, 4)::bigint * 16777216 + get_byte(value, 5)::bigint * 65536 + get_byte(value, 6)::bigint * 256 + get_byte(value, 7) AS word2
    FROM bytes
  )
  SELECT
    (CASE WHEN word1 >= 2147483648 THEN word1 - 4294967296 ELSE word1 END)::integer,
    (CASE WHEN word2 >= 2147483648 THEN word2 - 4294967296 ELSE word2 END)::integer
  FROM words
$function$;

CREATE FUNCTION surf_ace_allocator.base26(p_ordinal bigint)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  remaining bigint := p_ordinal;
  result text := '';
BEGIN
  IF p_ordinal < 0 THEN
    RAISE EXCEPTION 'ordinal must be non-negative' USING ERRCODE = '22003';
  END IF;
  LOOP
    result := chr(97 + (remaining % 26)::integer) || result;
    remaining := (remaining / 26) - 1;
    EXIT WHEN remaining < 0;
  END LOOP;
  RETURN result;
END
$function$;

CREATE FUNCTION surf_ace_allocator.canonical_json(p_value jsonb)
RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  result text;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || surf_ace_allocator.canonical_json(value), ',' ORDER BY key COLLATE "C"), '') || '}'
      INTO result FROM jsonb_each(p_value);
    WHEN 'array' THEN
      SELECT '[' || coalesce(string_agg(surf_ace_allocator.canonical_json(value), ',' ORDER BY ordinal), '') || ']'
      INTO result FROM jsonb_array_elements(p_value) WITH ORDINALITY AS items(value, ordinal);
    ELSE
      result := p_value::text;
  END CASE;
  RETURN result;
END
$function$;

CREATE FUNCTION surf_ace_allocator.assert_role(p_role name)
RETURNS void
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
BEGIN
  IF NOT pg_has_role(session_user, p_role, 'MEMBER') THEN
    RAISE EXCEPTION 'session lacks role %', p_role USING ERRCODE = '42501';
  END IF;
END
$function$;

CREATE FUNCTION surf_ace_allocator.assert_transaction_settings()
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
BEGIN
  IF current_setting('transaction_isolation') <> 'serializable'
     OR current_setting('synchronous_commit') <> 'remote_apply' THEN
    RAISE EXCEPTION 'allocator mutation requires SERIALIZABLE and remote_apply' USING ERRCODE = '55000';
  END IF;
END
$function$;

CREATE FUNCTION surf_ace_allocator.assert_advisory_lock(p_fleet_id text)
RETURNS void
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  keys record;
BEGIN
  SELECT * INTO keys FROM surf_ace_allocator.advisory_keys(p_fleet_id);
  IF NOT EXISTS (
    SELECT 1 FROM pg_locks
    WHERE locktype = 'advisory'
      AND pid = pg_backend_pid()
      AND granted
      AND classid::bigint = ((keys.key1::bigint + 4294967296) % 4294967296)
      AND objid::bigint = ((keys.key2::bigint + 4294967296) % 4294967296)
      AND objsubid = 2
  ) THEN
    RAISE EXCEPTION 'fleet advisory lock is not held by this backend' USING ERRCODE = '55000';
  END IF;
END
$function$;

CREATE FUNCTION surf_ace_allocator.assert_token(
  p_fleet_id text,
  p_lease_generation bigint,
  p_lease_id text,
  p_mode text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
BEGIN
  PERFORM surf_ace_allocator.assert_transaction_settings();
  SELECT * INTO fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF NOT FOUND OR fleet.lease_generation <> p_lease_generation
     OR fleet.lease_id IS DISTINCT FROM p_lease_id
     OR fleet.lease_mode IS DISTINCT FROM p_mode
     OR fleet.lease_backend_pid IS DISTINCT FROM pg_backend_pid() THEN
    RAISE EXCEPTION 'stale or wrong-mode allocator lease token' USING ERRCODE = '55000';
  END IF;
  PERFORM surf_ace_allocator.assert_advisory_lock(p_fleet_id);
END
$function$;

CREATE FUNCTION surf_ace_allocator.append_event(p_fleet_id text, p_event jsonb)
RETURNS TABLE (head_seq bigint, head_hash bytea, custody_revision bigint)
LANGUAGE plpgsql
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  bytes bytea;
  next_hash bytea;
BEGIN
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  bytes := convert_to(surf_ace_allocator.canonical_json(p_event), 'UTF8');
  next_hash := public.digest(fleet.head_hash || bytes, 'sha256');
  INSERT INTO surf_ace_allocator.custody_journal(
    fleet_id, allocator_id, head_seq, previous_head_hash, event_bytes, event, head_hash
  ) VALUES (
    fleet.fleet_id, fleet.allocator_id, fleet.head_seq + 1, fleet.head_hash, bytes, p_event, next_hash
  );
  UPDATE surf_ace_allocator.fleets
  SET head_seq = fleet.head_seq + 1,
      head_hash = next_hash,
      custody_revision = fleet.custody_revision + 1,
      last_commit_at = clock_timestamp()
  WHERE fleet_id = p_fleet_id;
  RETURN QUERY SELECT fleet.head_seq + 1, next_hash, fleet.custody_revision + 1;
END
$function$;

CREATE FUNCTION surf_ace_allocator.initialize_fleet(
  p_fleet_id text,
  p_allocator_id text,
  p_generation_id text,
  p_lease_id text
)
RETURNS TABLE (lease_generation bigint, lease_id text, mode text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_recovery');
  PERFORM surf_ace_allocator.assert_transaction_settings();
  PERFORM surf_ace_allocator.assert_advisory_lock(p_fleet_id);
  IF EXISTS (SELECT 1 FROM surf_ace_allocator.fleet_tombstones WHERE fleet_id = p_fleet_id) THEN
    RAISE EXCEPTION 'fleetId has existed and can never be initialized again' USING ERRCODE = '23505';
  END IF;
  INSERT INTO surf_ace_allocator.fleet_tombstones(fleet_id, first_allocator_id)
    VALUES (p_fleet_id, p_allocator_id);
  INSERT INTO surf_ace_allocator.fleets(
    fleet_id, allocator_id, state_version, accepted_generation_id,
    lease_generation, lease_id, lease_mode, lease_backend_pid
  ) VALUES (
    p_fleet_id, p_allocator_id, 1, p_generation_id,
    1, p_lease_id, 'recovery', pg_backend_pid()
  );
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', p_allocator_id,
    'fleetId', p_fleet_id,
    'generationId', p_generation_id,
    'stateVersion', 1,
    'type', 'initialized'
  ));
  RETURN QUERY SELECT 1::bigint, p_lease_id, 'recovery'::text;
END
$function$;

CREATE FUNCTION surf_ace_allocator.acquire_lease(p_fleet_id text, p_lease_id text, p_mode text)
RETURNS TABLE (lease_generation bigint, lease_id text, mode text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  next_generation bigint;
BEGIN
  IF p_mode = 'writer' THEN
    PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  ELSIF p_mode = 'recovery' THEN
    PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_recovery');
  ELSE
    RAISE EXCEPTION 'invalid lease mode' USING ERRCODE = '22023';
  END IF;
  PERFORM surf_ace_allocator.assert_transaction_settings();
  PERFORM surf_ace_allocator.assert_advisory_lock(p_fleet_id);
  SELECT fleets.lease_generation + 1 INTO STRICT next_generation
    FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  UPDATE surf_ace_allocator.fleets SET
    lease_generation = next_generation,
    lease_id = p_lease_id,
    lease_mode = p_mode,
    lease_backend_pid = pg_backend_pid(),
    custody_revision = custody_revision + 1,
    last_commit_at = clock_timestamp()
  WHERE fleet_id = p_fleet_id;
  RETURN QUERY SELECT next_generation, p_lease_id, p_mode;
END
$function$;

CREATE FUNCTION surf_ace_allocator.release_lease(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_mode text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
BEGIN
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, p_mode);
  UPDATE surf_ace_allocator.fleets SET
    lease_generation = lease_generation + 1,
    lease_id = NULL,
    lease_mode = NULL,
    lease_backend_pid = NULL,
    custody_revision = custody_revision + 1,
    last_commit_at = clock_timestamp()
  WHERE fleet_id = p_fleet_id;
END
$function$;

CREATE FUNCTION surf_ace_allocator.revoke_writer(p_fleet_id text, p_expected_generation bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_recovery');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.lease_mode <> 'writer' OR fleet.lease_generation <> p_expected_generation THEN
    RAISE EXCEPTION 'writer generation mismatch' USING ERRCODE = '55000';
  END IF;
  IF fleet.lease_backend_pid = pg_backend_pid() OR NOT pg_terminate_backend(fleet.lease_backend_pid) THEN
    RAISE EXCEPTION 'writer backend could not be terminated' USING ERRCODE = '55000';
  END IF;
  RETURN fleet.lease_backend_pid;
END
$function$;

CREATE FUNCTION surf_ace_allocator.bind_authority(
  p_fleet_id text, p_generation bigint, p_lease_id text,
  p_authority_id text, p_owner_anchor_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  existing_anchor text;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.lifecycle <> 'active' THEN
    RAISE EXCEPTION 'fleet is not active' USING ERRCODE = '55000';
  END IF;
  SELECT owner_anchor_id INTO existing_anchor FROM surf_ace_allocator.authority_owners
    WHERE fleet_id = p_fleet_id AND allocator_id = fleet.allocator_id
      AND generation_id = fleet.accepted_generation_id AND authority_id = p_authority_id;
  IF FOUND THEN
    IF existing_anchor <> p_owner_anchor_id THEN
      RAISE EXCEPTION 'authority ownership conflict' USING ERRCODE = '23505';
    END IF;
    RETURN 'bound';
  END IF;
  INSERT INTO surf_ace_allocator.authority_owners(
    fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id
  ) VALUES (
    p_fleet_id, fleet.allocator_id, fleet.accepted_generation_id, p_authority_id, p_owner_anchor_id
  );
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id,
    'authorityId', p_authority_id,
    'fleetId', p_fleet_id,
    'ownerAnchorId', p_owner_anchor_id,
    'type', 'authority-bound'
  ));
  RETURN 'bound';
END
$function$;

CREATE FUNCTION surf_ace_allocator.reserve_ordinal(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_transaction_id text,
  p_authority_id text, p_owner_anchor_id text, p_surface_id text
)
RETURNS TABLE (status text, ordinal bigint, window_label text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  tx surf_ace_allocator.allocation_transactions%ROWTYPE;
  assigned surf_ace_allocator.assignments%ROWTYPE;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.lifecycle <> 'active' THEN
    RAISE EXCEPTION 'fleet is not active' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO assigned FROM surf_ace_allocator.assignments
    WHERE fleet_id = p_fleet_id AND allocator_id = fleet.allocator_id
      AND generation_id = fleet.accepted_generation_id
      AND authority_id = p_authority_id AND surface_id = p_surface_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'committed'::text, assigned.ordinal, assigned.window_label;
    RETURN;
  END IF;
  SELECT * INTO tx FROM surf_ace_allocator.allocation_transactions WHERE transaction_id = p_transaction_id AND generation_id = fleet.accepted_generation_id;
  IF FOUND THEN
    IF tx.fleet_id <> p_fleet_id OR tx.authority_id <> p_authority_id
       OR tx.owner_anchor_id <> p_owner_anchor_id OR tx.surface_id <> p_surface_id THEN
      RAISE EXCEPTION 'transaction identity conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT tx.status, tx.ordinal, CASE WHEN tx.status = 'committed' THEN surf_ace_allocator.base26(tx.ordinal) ELSE NULL END;
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
  INSERT INTO surf_ace_allocator.allocation_transactions(
    transaction_id, fleet_id, allocator_id, generation_id,
    authority_id, owner_anchor_id, surface_id, ordinal, status
  ) VALUES (
    p_transaction_id, p_fleet_id, fleet.allocator_id, fleet.accepted_generation_id,
    p_authority_id, p_owner_anchor_id, p_surface_id, fleet.next_ordinal_fence, 'reserved'
  );
  UPDATE surf_ace_allocator.fleets SET next_ordinal_fence = next_ordinal_fence + 1
    WHERE fleet_id = p_fleet_id;
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id,
    'authorityId', p_authority_id,
    'fleetId', p_fleet_id,
    'ordinal', fleet.next_ordinal_fence,
    'ownerAnchorId', p_owner_anchor_id,
    'surfaceId', p_surface_id,
    'transactionId', p_transaction_id,
    'type', 'reserved'
  ));
  RETURN QUERY SELECT 'reserved'::text, fleet.next_ordinal_fence, NULL::text;
END
$function$;

CREATE FUNCTION surf_ace_allocator.commit_mapping(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_transaction_id text
)
RETURNS TABLE (
  authority_id text, owner_anchor_id text, surface_id text,
  ordinal bigint, window_label text, recovered_at_custody_revision bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  tx surf_ace_allocator.allocation_transactions%ROWTYPE;
  label text;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  SELECT * INTO STRICT tx FROM surf_ace_allocator.allocation_transactions
    WHERE transaction_id = p_transaction_id AND generation_id = fleet.accepted_generation_id FOR UPDATE;
  IF tx.fleet_id <> p_fleet_id OR tx.allocator_id <> fleet.allocator_id
     OR tx.generation_id <> fleet.accepted_generation_id OR tx.status = 'burned' THEN
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
    PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
      'allocatorId', tx.allocator_id,
      'authorityId', tx.authority_id,
      'fleetId', p_fleet_id,
      'ordinal', tx.ordinal,
      'ownerAnchorId', tx.owner_anchor_id,
      'surfaceId', tx.surface_id,
      'transactionId', p_transaction_id,
      'type', 'committed',
      'windowLabel', label
    ));
  END IF;
  RETURN QUERY SELECT tx.authority_id, tx.owner_anchor_id, tx.surface_id,
    tx.ordinal, label, NULL::bigint;
END
$function$;

CREATE FUNCTION surf_ace_allocator.burn_reservation(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_transaction_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  tx surf_ace_allocator.allocation_transactions%ROWTYPE;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  SELECT * INTO STRICT tx FROM surf_ace_allocator.allocation_transactions
    WHERE transaction_id = p_transaction_id AND generation_id = fleet.accepted_generation_id FOR UPDATE;
  IF tx.status = 'committed' THEN
    RAISE EXCEPTION 'committed transaction cannot burn' USING ERRCODE = '55000';
  END IF;
  IF tx.status = 'reserved' THEN
    UPDATE surf_ace_allocator.allocation_transactions
      SET status = 'burned', updated_at = clock_timestamp()
      WHERE transaction_id = p_transaction_id AND generation_id = fleet.accepted_generation_id;
    PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
      'allocatorId', tx.allocator_id,
      'authorityId', tx.authority_id,
      'fleetId', p_fleet_id,
      'ordinal', tx.ordinal,
      'surfaceId', tx.surface_id,
      'transactionId', p_transaction_id,
      'type', 'burned'
    ));
  END IF;
  RETURN 'burned';
END
$function$;

CREATE FUNCTION surf_ace_allocator.query_transaction(p_transaction_id text)
RETURNS TABLE (
  status text, fleet_id text, allocator_id text, authority_id text,
  owner_anchor_id text, surface_id text, ordinal bigint, window_label text
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  SELECT tx.status, tx.fleet_id, tx.allocator_id, tx.authority_id,
    tx.owner_anchor_id, tx.surface_id, tx.ordinal,
    CASE WHEN tx.status = 'committed' THEN surf_ace_allocator.base26(tx.ordinal) ELSE NULL END
  FROM surf_ace_allocator.allocation_transactions tx
  JOIN surf_ace_allocator.fleets f ON f.fleet_id = tx.fleet_id AND f.allocator_id = tx.allocator_id
    AND f.accepted_generation_id = tx.generation_id
  WHERE tx.transaction_id = p_transaction_id
$function$;

CREATE FUNCTION surf_ace_allocator.read_accepted_state(p_fleet_id text)
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

CREATE FUNCTION surf_ace_allocator.read_head_witness(p_fleet_id text)
RETURNS TABLE (
  cluster_system_id text, timeline_id integer, witness_server_id text,
  receiver_slot_name text, sender_host text, sender_port integer,
  replay_lsn pg_lsn, fleet_id text, allocator_id text,
  head_seq bigint, head_hash text, custody_revision bigint
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
  SELECT s.system_identifier::text,
    c.timeline_id,
    current_setting('surf_ace.witness_server_id', true),
    r.slot_name,
    r.sender_host,
    r.sender_port,
    pg_last_wal_replay_lsn(),
    f.fleet_id,
    f.allocator_id,
    f.head_seq,
    encode(f.head_hash, 'hex'),
    f.custody_revision
  FROM pg_control_system() s
  CROSS JOIN pg_control_checkpoint() c
  CROSS JOIN surf_ace_allocator.fleets f
  LEFT JOIN pg_stat_wal_receiver r ON true
  WHERE f.fleet_id = p_fleet_id
$function$;

CREATE FUNCTION surf_ace_allocator.stage_restore(
  p_fleet_id text, p_generation bigint, p_lease_id text,
  p_restore_generation_id text, p_idempotency_id text,
  p_snapshot jsonb, p_base_head_seq bigint, p_base_head_hash bytea
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
  existing surf_ace_allocator.restore_generations%ROWTYPE;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_recovery');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'recovery');
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  SELECT * INTO existing FROM surf_ace_allocator.restore_generations WHERE idempotency_id = p_idempotency_id;
  IF FOUND THEN
    IF existing.generation_id <> p_restore_generation_id OR existing.source_snapshot <> p_snapshot THEN
      RAISE EXCEPTION 'restore idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN existing.state;
  END IF;
  IF p_base_head_seq <> fleet.head_seq OR p_base_head_hash <> fleet.head_hash THEN
    RAISE EXCEPTION 'restore source does not end at current head' USING ERRCODE = '55000';
  END IF;
  INSERT INTO surf_ace_allocator.restore_generations(
    generation_id, fleet_id, allocator_id, idempotency_id, state,
    source_snapshot, base_head_seq, base_head_hash, prior_generation_id
  ) VALUES (
    p_restore_generation_id, p_fleet_id, fleet.allocator_id, p_idempotency_id, 'preparing',
    p_snapshot, p_base_head_seq, p_base_head_hash, fleet.accepted_generation_id
  );
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'fleetId', p_fleet_id,
    'generationId', p_restore_generation_id, 'type', 'restore-prepared'
  ));
  RETURN 'preparing';
END
$function$;

CREATE FUNCTION surf_ace_allocator.mark_restore_ready(
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
  max_ordinal bigint;
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
  IF restore.source_snapshot->>'fleetId' <> fleet.fleet_id
     OR restore.source_snapshot->>'allocatorId' <> fleet.allocator_id
     OR (restore.source_snapshot->>'stateVersion')::integer <> fleet.state_version THEN
    RAISE EXCEPTION 'restore identity mismatch' USING ERRCODE = '55000';
  END IF;
  INSERT INTO surf_ace_allocator.authority_owners(
    fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id, bound_at
  ) SELECT fleet_id, allocator_id, restore.generation_id, authority_id, owner_anchor_id, bound_at
    FROM surf_ace_allocator.authority_owners
    WHERE fleet_id = fleet.fleet_id AND allocator_id = fleet.allocator_id
      AND generation_id = fleet.accepted_generation_id;
  INSERT INTO surf_ace_allocator.allocation_transactions(
    transaction_id, fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id,
    surface_id, ordinal, status, created_at, updated_at
  ) SELECT transaction_id, fleet_id, allocator_id, restore.generation_id, authority_id, owner_anchor_id,
      surface_id, ordinal, status, created_at, updated_at
    FROM surf_ace_allocator.allocation_transactions
    WHERE fleet_id = fleet.fleet_id AND allocator_id = fleet.allocator_id
      AND generation_id = fleet.accepted_generation_id;
  INSERT INTO surf_ace_allocator.assignments(
    fleet_id, allocator_id, generation_id, authority_id, owner_anchor_id, surface_id,
    transaction_id, ordinal, window_label, recovered_at_custody_revision, committed_at
  ) SELECT fleet_id, allocator_id, restore.generation_id, authority_id, owner_anchor_id, surface_id,
      transaction_id, ordinal, window_label, fleet.custody_revision + 1, committed_at
    FROM surf_ace_allocator.assignments
    WHERE fleet_id = fleet.fleet_id AND allocator_id = fleet.allocator_id
      AND generation_id = fleet.accepted_generation_id;
  max_ordinal := fleet.next_ordinal_fence - 1;
  SELECT * INTO appended FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', fleet.allocator_id, 'computedFence', max_ordinal + 1,
    'fleetId', p_fleet_id, 'generationId', restore.generation_id,
    'type', 'restore-ready'
  ));
  UPDATE surf_ace_allocator.restore_generations SET
    state = 'ready', ready_head_seq = appended.head_seq,
    ready_head_hash = appended.head_hash, computed_fence = max_ordinal + 1
  WHERE generation_id = restore.generation_id;
  RETURN QUERY SELECT appended.head_seq, encode(appended.head_hash, 'hex'), max_ordinal + 1;
END
$function$;

CREATE FUNCTION surf_ace_allocator.activate_restore(
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
    next_ordinal_fence = restore.computed_fence
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

CREATE FUNCTION surf_ace_allocator.discard_restore(
  p_fleet_id text, p_generation bigint, p_lease_id text, p_restore_generation_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  restore surf_ace_allocator.restore_generations%ROWTYPE;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_recovery');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'recovery');
  SELECT * INTO STRICT restore FROM surf_ace_allocator.restore_generations
    WHERE generation_id = p_restore_generation_id FOR UPDATE;
  IF restore.state = 'activated' THEN
    RAISE EXCEPTION 'activated restore cannot be discarded' USING ERRCODE = '55000';
  END IF;
  DELETE FROM surf_ace_allocator.assignments WHERE generation_id = restore.generation_id;
  DELETE FROM surf_ace_allocator.allocation_transactions WHERE generation_id = restore.generation_id;
  DELETE FROM surf_ace_allocator.authority_owners WHERE generation_id = restore.generation_id;
  UPDATE surf_ace_allocator.restore_generations SET state = 'discarded'
    WHERE generation_id = restore.generation_id;
  PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
    'allocatorId', restore.allocator_id, 'fleetId', p_fleet_id,
    'generationId', restore.generation_id, 'type', 'restore-discarded'
  ));
  RETURN 'discarded';
END
$function$;

RESET ROLE;

REVOKE ALL ON ALL TABLES IN SCHEMA surf_ace_allocator FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA surf_ace_allocator FROM PUBLIC;

GRANT EXECUTE ON FUNCTION surf_ace_allocator.advisory_keys(text) TO
  surf_ace_allocator_writer, surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.acquire_lease(text, text, text) TO
  surf_ace_allocator_writer, surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.release_lease(text, bigint, text, text) TO
  surf_ace_allocator_writer, surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.bind_authority(text, bigint, text, text, text) TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.reserve_ordinal(text, bigint, text, text, text, text, text) TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.commit_mapping(text, bigint, text, text) TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.burn_reservation(text, bigint, text, text) TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.query_transaction(text) TO
  surf_ace_allocator_writer, surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.read_accepted_state(text) TO
  surf_ace_allocator_writer, surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.initialize_fleet(text, text, text, text) TO surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.revoke_writer(text, bigint) TO surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.stage_restore(text, bigint, text, text, text, jsonb, bigint, bytea) TO surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.mark_restore_ready(text, bigint, text, text) TO surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.activate_restore(text, bigint, text, text, bigint, bytea) TO surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.discard_restore(text, bigint, text, text) TO surf_ace_allocator_recovery;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.read_head_witness(text) TO surf_ace_allocator_witness;
REVOKE EXECUTE ON FUNCTION pg_control_system(), pg_control_checkpoint() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_control_system(), pg_control_checkpoint() TO
  surf_ace_allocator_owner, surf_ace_allocator_writer, surf_ace_allocator_recovery;

SET ROLE surf_ace_allocator_owner;
CREATE FUNCTION surf_ace_allocator.validate_journal(p_fleet_id text)
RETURNS boolean
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  expected_seq bigint := 0;
  expected_hash bytea := decode(repeat('00', 32), 'hex');
  entry record;
  fleet surf_ace_allocator.fleets%ROWTYPE;
BEGIN
  FOR entry IN
    SELECT * FROM surf_ace_allocator.custody_journal
    WHERE fleet_id = p_fleet_id ORDER BY head_seq
  LOOP
    expected_seq := expected_seq + 1;
    IF entry.head_seq <> expected_seq
       OR entry.previous_head_hash <> expected_hash
       OR entry.event_bytes <> convert_to(surf_ace_allocator.canonical_json(entry.event), 'UTF8')
       OR entry.head_hash <> public.digest(expected_hash || entry.event_bytes, 'sha256') THEN
      RETURN false;
    END IF;
    expected_hash := entry.head_hash;
  END LOOP;
  SELECT * INTO fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id;
  RETURN FOUND AND fleet.head_seq = expected_seq AND fleet.head_hash = expected_hash;
END
$function$;
RESET ROLE;
REVOKE ALL ON FUNCTION surf_ace_allocator.validate_journal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.validate_journal(text) TO
  surf_ace_allocator_writer, surf_ace_allocator_recovery;
