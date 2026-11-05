import type { Sql } from "postgres";

export async function recordServiceHeartbeat(
  sql: Sql,
  serviceName: string,
  startedAt: Date,
  payload: Record<string, unknown> = {}
) {
  await sql`
    INSERT INTO service_heartbeats (
      service_name,
      payload,
      started_at,
      last_seen_at
    )
    VALUES (
      ${serviceName},
      CAST(${JSON.stringify(payload)} AS jsonb),
      ${startedAt},
      NOW()
    )
    ON CONFLICT (service_name)
    DO UPDATE SET
      payload = EXCLUDED.payload,
      started_at = EXCLUDED.started_at,
      last_seen_at = NOW()
  `;
}
