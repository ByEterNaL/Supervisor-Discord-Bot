CREATE OR REPLACE FUNCTION ensure_month_partition(base_table TEXT, partition_month DATE)
RETURNS VOID AS $$
DECLARE
  start_ts TIMESTAMPTZ;
  end_ts TIMESTAMPTZ;
  partition_name TEXT;
BEGIN
  start_ts := date_trunc('month', partition_month)::timestamptz;
  end_ts := (date_trunc('month', partition_month) + INTERVAL '1 month')::timestamptz;
  partition_name := format('%s_%s', base_table, to_char(partition_month, 'YYYY_MM'));

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    base_table,
    start_ts,
    end_ts
  );
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS voice_active_segments_default PARTITION OF voice_active_segments DEFAULT;
CREATE TABLE IF NOT EXISTS camera_segments_default PARTITION OF camera_segments DEFAULT;
CREATE TABLE IF NOT EXISTS stream_segments_default PARTITION OF stream_segments DEFAULT;

DO $$
DECLARE
  month_offset INTEGER;
  month_value DATE;
BEGIN
  FOR month_offset IN -1..12 LOOP
    month_value := (date_trunc('month', now()) + (month_offset || ' month')::interval)::date;
    PERFORM ensure_month_partition('voice_active_segments', month_value);
    PERFORM ensure_month_partition('camera_segments', month_value);
    PERFORM ensure_month_partition('stream_segments', month_value);
  END LOOP;
END;
$$;
