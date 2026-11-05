import { describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../../../packages/shared/src";
import { RankService } from "../src/services/rank-service";

function createSqlMock(responses: unknown[] = []) {
  const calls: Array<{ query: string; values: unknown[] }> = [];

  type SqlMock = {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
    begin: (callback: (transaction: SqlMock) => Promise<unknown>) => Promise<unknown>;
  };

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join("?"), values });
    return Promise.resolve((responses.shift() as unknown) ?? []);
  }) as SqlMock;

  sql.begin = async (callback) => callback(sql as never);

  return { sql, calls };
}

function createConfig() {
  return {
    ...defaultConfig,
    rankSystem: {
      ...defaultConfig.rankSystem,
      enabled: true,
      text: {
        ...defaultConfig.rankSystem.text,
        enabled: true,
        xpPerEligibleMessage: 5,
        cooldownSeconds: 45,
        minNormalizedLength: 8,
        duplicateWindowMinutes: 10,
        hourlyEligibleCap: 20
      }
    }
  };
}

function createConfigWithTopLevelDisabled() {
  return {
    ...createConfig(),
    rankSystem: {
      ...createConfig().rankSystem,
      enabled: false,
    },
  };
}

describe("RankService message xp", () => {
  it("awards text xp for an eligible message", async () => {
    const { sql, calls } = createSqlMock([[], [], [], [], []]);
    const service = new RankService(
      sql as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { getMemberType: vi.fn(() => "user") } as never,
      createConfig
    );

    await service.handleMessageXp({
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "channel-1",
      content: "Merhaba dünya test mesajı",
      createdAt: new Date(),
      id: "message-1",
      author: { id: "user-1", bot: false },
      member: { id: "user-1" },
      channel: { isTextBased: () => true, parentId: null }
    } as never);

    expect(calls.some((call) => call.query.includes("INSERT INTO rank_text_state"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO rank_profiles"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO rank_events"))).toBe(true);
  });

  it("blocks duplicate content inside the duplicate window", async () => {
    const now = new Date();
    const { sql, calls } = createSqlMock([
      [
        {
          last_eligible_at: null,
          recent_contents: JSON.stringify([{ content: "merhaba dünya test mesajı", at: now.toISOString() }]),
          hour_window_started_at: now,
          hour_message_count: 1
        }
      ],
      []
    ]);
    const service = new RankService(
      sql as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { getMemberType: vi.fn(() => "user") } as never,
      createConfig
    );

    await service.handleMessageXp({
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "channel-1",
      content: "Merhaba dünya test mesajı",
      createdAt: now,
      id: "message-2",
      author: { id: "user-1", bot: false },
      member: { id: "user-1" },
      channel: { isTextBased: () => true, parentId: null }
    } as never);

    expect(calls.some((call) => call.query.includes("INSERT INTO rank_text_state"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO rank_profiles"))).toBe(false);
  });

  it("still awards text xp when only the top-level rank flag is off", async () => {
    const { sql, calls } = createSqlMock([[], [], [], [], []]);
    const service = new RankService(
      sql as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { getMemberType: vi.fn(() => "user") } as never,
      createConfigWithTopLevelDisabled
    );

    await service.handleMessageXp({
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "channel-1",
      content: "Bu mesaj artik deneysel olarak XP kazandiracak.",
      createdAt: new Date(),
      id: "message-3",
      author: { id: "user-1", bot: false },
      member: { id: "user-1" },
      channel: { isTextBased: () => true, parentId: null }
    } as never);

    expect(calls.some((call) => call.query.includes("INSERT INTO rank_profiles"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO rank_events"))).toBe(true);
  });

  it("announces only the latest valid level once for pending level effects", async () => {
    const responses = [
      [
        {
          id: "event-1",
          user_id: "user-1",
          xp_type: "voice",
          level_after: 1,
          source_type: "voice-runtime",
          role_sync_processed_at: null,
          announcement_processed_at: null
        },
        {
          id: "event-2",
          user_id: "user-1",
          xp_type: "voice",
          level_after: 2,
          source_type: "voice-runtime",
          role_sync_processed_at: null,
          announcement_processed_at: null
        },
        {
          id: "event-3",
          user_id: "user-1",
          xp_type: "voice",
          level_after: 3,
          source_type: "voice-runtime",
          role_sync_processed_at: null,
          announcement_processed_at: null
        }
      ],
      [{ voice_level: 3, text_level: 0 }],
      [],
      [],
      []
    ];
    const { sql, calls } = createSqlMock(responses);
    const send = vi.fn();
    const service = new RankService(
      sql as never,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      { getMemberType: vi.fn(() => "user") } as never,
      () => ({
        ...createConfig(),
        rankSystem: {
          ...createConfig().rankSystem,
          rewards: {
            ...createConfig().rankSystem.rewards,
            levelUpMessagesEnabled: true,
            announcementChannelId: "channel-1"
          }
        }
      })
    );

    await service.processPendingLevelEffects({
      id: "guild-1",
      members: {
        fetch: vi.fn(async () => ({
          displayName: "Tester",
          displayAvatarURL: vi.fn(() => "https://example.com/avatar.png"),
          toString: (): string => "<@user-1>"
        }))
      },
      channels: {
        fetch: vi.fn(async () => ({
          isTextBased: () => true,
          send
        }))
      }
    } as never);

    expect(send).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.query.includes("UPDATE rank_events")).length).toBe(3);
  });
});
