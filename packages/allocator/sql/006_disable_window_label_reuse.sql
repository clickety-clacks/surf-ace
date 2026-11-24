BEGIN;
SET ROLE surf_ace_allocator_owner;
SET search_path = pg_catalog, surf_ace_allocator;

-- Apply after 005. Installing the operator function does not change any gate or allocation.
CREATE OR REPLACE FUNCTION surf_ace_allocator.disable_window_label_reuse(p_fleet_id text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, surf_ace_allocator
AS $function$
DECLARE
  fleet surf_ace_allocator.fleets%ROWTYPE;
BEGIN
  PERFORM surf_ace_allocator.assert_role('surf_ace_allocator_owner');
  IF p_reason IS NULL OR p_reason !~ '^[A-Za-z0-9._:-]{1,128}$' THEN
    RAISE EXCEPTION 'invalid window reuse disable reason' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO STRICT fleet FROM surf_ace_allocator.fleets WHERE fleet_id = p_fleet_id FOR UPDATE;
  IF fleet.window_label_schema_version <> 2 THEN
    RAISE EXCEPTION 'window generation schema is not current' USING ERRCODE = '55000';
  END IF;
  IF fleet.window_label_reuse_enabled THEN
    PERFORM * FROM surf_ace_allocator.append_event(p_fleet_id, jsonb_build_object(
      'allocatorId', fleet.allocator_id, 'enabled', false,
      'fleetId', p_fleet_id, 'reason', p_reason, 'type', 'window-label-reuse-gate'));
    UPDATE surf_ace_allocator.fleets SET window_label_reuse_enabled = false WHERE fleet_id = p_fleet_id;
  END IF;
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION surf_ace_allocator.disable_window_label_reuse(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION surf_ace_allocator.disable_window_label_reuse(text, text)
  TO surf_ace_allocator_owner;

RESET ROLE;
COMMIT;
