DELETE FROM voice_active_segments
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY guild_id, user_id, channel_id, started_at, ended_at
        ORDER BY id
      ) AS duplicate_rank
    FROM voice_active_segments
  ) AS ranked
  WHERE duplicate_rank > 1
);

DELETE FROM camera_segments
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY guild_id, user_id, channel_id, started_at, ended_at
        ORDER BY id
      ) AS duplicate_rank
    FROM camera_segments
  ) AS ranked
  WHERE duplicate_rank > 1
);

DELETE FROM stream_segments
WHERE id IN (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY guild_id, user_id, channel_id, started_at, ended_at
        ORDER BY id
      ) AS duplicate_rank
    FROM stream_segments
  ) AS ranked
  WHERE duplicate_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS voice_active_segments_dedupe_idx
ON voice_active_segments (guild_id, user_id, channel_id, started_at, ended_at);

CREATE UNIQUE INDEX IF NOT EXISTS camera_segments_dedupe_idx
ON camera_segments (guild_id, user_id, channel_id, started_at, ended_at);

CREATE UNIQUE INDEX IF NOT EXISTS stream_segments_dedupe_idx
ON stream_segments (guild_id, user_id, channel_id, started_at, ended_at);
