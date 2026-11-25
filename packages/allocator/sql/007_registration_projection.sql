BEGIN;
SET ROLE surf_ace_allocator_owner;
SET search_path = pg_catalog, surf_ace_allocator;

-- Presence is process-local. This projection keeps the last registered
-- inventory for offline lookups after restart. It grants no allocation rights.
CREATE TABLE surf_ace_allocator.registration_projections (
  fleet_id text NOT NULL REFERENCES surf_ace_allocator.fleets(fleet_id),
  client_id text NOT NULL,
  projection jsonb NOT NULL,
  PRIMARY KEY (fleet_id, client_id)
);

CREATE FUNCTION surf_ace_allocator.remember_registration(
  p_fleet_id text, p_generation bigint, p_lease_id text,
  p_client_id text, p_projection jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  INSERT INTO surf_ace_allocator.registration_projections(fleet_id, client_id, projection)
    VALUES (p_fleet_id, p_client_id, p_projection)
    ON CONFLICT (fleet_id, client_id) DO UPDATE SET projection = EXCLUDED.projection
    WHERE registration_projections.projection IS DISTINCT FROM EXCLUDED.projection;
END
$function$;

CREATE FUNCTION surf_ace_allocator.read_registrations(
  p_fleet_id text, p_generation bigint, p_lease_id text
) RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_writer');
  PERFORM surf_ace_allocator.assert_token(p_fleet_id, p_generation, p_lease_id, 'writer');
  RETURN QUERY SELECT projection FROM surf_ace_allocator.registration_projections
    WHERE fleet_id = p_fleet_id ORDER BY client_id;
END
$function$;

REVOKE ALL ON FUNCTION surf_ace_allocator.remember_registration(text, bigint, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION surf_ace_allocator.read_registrations(text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.remember_registration(text, bigint, text, text, jsonb) TO surf_ace_allocator_writer;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.read_registrations(text, bigint, text) TO surf_ace_allocator_writer;

RESET ROLE;
COMMIT;
