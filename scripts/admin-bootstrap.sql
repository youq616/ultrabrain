-- Native GBrain v35 compatibility, adapted from vendor/gbrain/src/core/migrate.ts (MIT).
-- Run only by the managed cluster administrator. Runtime never receives SUPERUSER.
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE p.proname='auto_enable_rls' AND n.nspname='public') THEN
    EXECUTE $fn$
      CREATE FUNCTION public.auto_enable_rls() RETURNS event_trigger
      LANGUAGE plpgsql SECURITY INVOKER AS $body$
      DECLARE obj record;
      BEGIN
        FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands()
                   WHERE object_type='table' AND schema_name='public'
        LOOP
          EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',obj.object_identity);
        END LOOP;
      END;
      $body$
    $fn$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname='auto_rls_on_create_table') THEN
    EXECUTE $trg$
      CREATE EVENT TRIGGER auto_rls_on_create_table ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
      EXECUTE FUNCTION public.auto_enable_rls()
    $trg$;
  END IF;
END;
$bootstrap$;
-- Later native migrations harden the function search_path as its owner.
ALTER FUNCTION public.auto_enable_rls() OWNER TO ultrabrain;
