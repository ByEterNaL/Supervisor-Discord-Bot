import { describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../../../packages/shared/src";
import { PresenceService } from "../src/services/presence-service";

function createSqlMock(responses: unknown[] = []) {
  const calls: Array<{ kind: "tag" | "unsafe"; query: string; values: unknown[] }> = [];

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ kind: "tag", query: strings.join("?"), values });
    return Promise.resolve((responses.shift() as unknown) ?? []);
  }) as unknown as {
    unsafe: (query: string, values?: unknown[]) => Promise<unknown>;
  };

  sql.unsafe = vi.fn(async (query: string, values: unknown[] = []) => {
    calls.push({ kind: "unsafe", query, values });
    return [];
  });

  return { sql, calls };
}

describe("PresenceService syncGuild", () => {
  it("archives stale live sessions on restart and reopens only currently visible sessions", async () => {
    const staleStartedAt = new Date(Date.now() - 60_000);
    const previousHeartbeatAt = new Date(Date.now() - 15_000);
    const staleRow = {
      guild_id: "guild-1",
      user_id: "user-1",
      session_type: "voice",
      channel_id: "channel-1",
      started_at: staleStartedAt,
      last_confirmed_at: previousHeartbeatAt
    };

    const { sql, calls } = createSqlMock([
      [{ last_seen_at: previousHeartbeatAt }],
      [staleRow],
      [staleRow],
      [],
      [],
      []
    ]);
    const logger = { info: vi.fn() };
    const memberService = { syncMember: vi.fn().mockResolvedValue(undefined) };
    const service = new PresenceService(
      sql as never,
      logger as never,
      memberService as never,
      () => ({ ...defaultConfig })
    );

    const guild = {
      id: "guild-1",
      voiceStates: {
        cache: new Map([
          [
            "user-1",
            {
              id: "user-1",
              member: {
                id: "user-1",
                user: { bot: false }
              },
              channelId: "channel-1",
              channel: { parentId: null },
              selfMute: false,
              serverMute: false,
              selfDeaf: false,
              serverDeaf: false,
              streaming: false,
              selfVideo: false
            }
          ]
        ])
      }
    };

    await service.syncGuild(guild as never);

    expect(memberService.syncMember).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.query.includes("DELETE FROM live_presence_sessions"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO live_presence_sessions"))).toBe(true);
    expect(calls.some((call) => call.query.includes("ensure_month_partition"))).toBe(true);
    expect(calls.some((call) => call.kind === "unsafe" && call.query.includes("INSERT INTO voice_active_segments"))).toBe(true);

    const archivedSegmentCall = calls.find(
      (call) => call.kind === "unsafe" && call.query.includes("INSERT INTO voice_active_segments")
    );
    expect(archivedSegmentCall?.values?.[4]).toEqual(previousHeartbeatAt);
  });

  it("closes unconfirmed live sessions conservatively during reconciliation", async () => {
    const startedAt = new Date(Date.now() - 10 * 60_000);
    const lastConfirmedAt = new Date(Date.now() - 5 * 60_000);
    const liveRow = {
      guild_id: "guild-1",
      user_id: "user-2",
      session_type: "voice",
      channel_id: "channel-2",
      started_at: startedAt,
      last_confirmed_at: lastConfirmedAt
    };

    const { sql, calls } = createSqlMock([
      [liveRow],
      [liveRow],
      [],
      []
    ]);
    const logger = { info: vi.fn() };
    const memberService = { syncMember: vi.fn().mockResolvedValue(undefined) };
    const service = new PresenceService(
      sql as never,
      logger as never,
      memberService as never,
      () => ({ ...defaultConfig })
    );

    const guild = {
      id: "guild-1",
      voiceStates: { cache: new Map() }
    };

    await service.reconcileGuild(guild as never);

    const archivedSegmentCall = calls.find(
      (call) => call.kind === "unsafe" && call.query.includes("INSERT INTO voice_active_segments")
    );
    expect(archivedSegmentCall?.values?.[4]).toEqual(lastConfirmedAt);
  });
});
