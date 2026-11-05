import { describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../../../packages/shared/src";
import { ModerationService } from "../src/services/moderation-service";

function createSqlMock(responses: unknown[] = []) {
  const calls: Array<{ query: string; values: unknown[] }> = [];

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join("?"), values });
    return Promise.resolve((responses.shift() as unknown) ?? []);
  }) as never;

  return { sql, calls };
}

function createConfig() {
  return {
    ...defaultConfig,
    channelAnalysis: {
      rules: [
        {
          id: "rule-1",
          channelId: "channel-1",
          maxMessagesPerHour: 3,
          timeoutMinutes: 15
        }
      ]
    }
  };
}

describe("ModerationService channel analysis", () => {
  it("applies timeout when the hourly channel threshold is exceeded", async () => {
    const { sql, calls } = createSqlMock([[], [], [{ message_count: 4 }], [], []]);
    const memberService = {
      syncMember: vi.fn().mockResolvedValue(undefined),
      syncUserShell: vi.fn().mockResolvedValue(undefined)
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ModerationService(
      sql,
      logger as never,
      memberService as never,
      createConfig
    );

    const timeout = vi.fn().mockResolvedValue(undefined);
    const message = {
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "channel-1",
      createdTimestamp: Date.now(),
      createdAt: new Date(),
      author: { id: "user-1", bot: false },
      member: {
        id: "user-1",
        displayName: "Kullanici",
        displayAvatarURL: () => "https://example.com/user.png",
        communicationDisabledUntilTimestamp: null,
        moderatable: true,
        timeout
      },
      channel: {
        name: "gorsel-sohbet"
      },
      client: {
        user: {
          id: "bot-1",
          username: "SupervisorBot",
          displayAvatarURL: () => "https://example.com/bot.png"
        }
      }
    };

    await service.handleChannelAnalysisMessage(message as never);

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(
      15 * 60 * 1000,
      expect.stringContaining("Kanal Analizi:")
    );
    expect(memberService.syncUserShell).toHaveBeenCalledWith(
      "guild-1",
      expect.objectContaining({ id: "bot-1" }),
      "user"
    );
    expect(calls.some((call) => call.query.includes("channel_analysis_message_events"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO moderation_actions"))).toBe(true);
  });

  it("does not apply timeout when the threshold is not exceeded", async () => {
    const { sql, calls } = createSqlMock([[], [], [{ message_count: 3 }]]);
    const memberService = {
      syncMember: vi.fn().mockResolvedValue(undefined),
      syncUserShell: vi.fn().mockResolvedValue(undefined)
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ModerationService(
      sql,
      logger as never,
      memberService as never,
      createConfig
    );

    const timeout = vi.fn().mockResolvedValue(undefined);
    const message = {
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "channel-1",
      createdTimestamp: Date.now(),
      createdAt: new Date(),
      author: { id: "user-1", bot: false },
      member: {
        id: "user-1",
        displayName: "Kullanici",
        displayAvatarURL: () => "https://example.com/user.png",
        communicationDisabledUntilTimestamp: null,
        moderatable: true,
        timeout
      },
      channel: {
        name: "gorsel-sohbet"
      },
      client: {
        user: {
          id: "bot-1",
          username: "SupervisorBot",
          displayAvatarURL: () => "https://example.com/bot.png"
        }
      }
    };

    await service.handleChannelAnalysisMessage(message as never);

    expect(timeout).not.toHaveBeenCalled();
    expect(calls.some((call) => call.query.includes("INSERT INTO moderation_actions"))).toBe(false);
  });

  it("records a blocked attempt when Discord does not allow timing out the member", async () => {
    const { sql, calls } = createSqlMock([[], [], [{ message_count: 4 }], [], []]);
    const memberService = {
      syncMember: vi.fn().mockResolvedValue(undefined),
      syncUserShell: vi.fn().mockResolvedValue(undefined)
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const service = new ModerationService(
      sql,
      logger as never,
      memberService as never,
      createConfig
    );

    const timeout = vi.fn().mockResolvedValue(undefined);
    const message = {
      inGuild: () => true,
      guildId: "guild-1",
      channelId: "channel-1",
      createdTimestamp: Date.now(),
      createdAt: new Date(),
      author: { id: "user-1", bot: false },
      member: {
        id: "user-1",
        displayName: "Kullanici",
        displayAvatarURL: () => "https://example.com/user.png",
        communicationDisabledUntilTimestamp: null,
        moderatable: false,
        timeout
      },
      guild: {
        ownerId: "user-1"
      },
      channel: {
        name: "gorsel-sohbet"
      },
      client: {
        user: {
          id: "bot-1",
          username: "SupervisorBot",
          displayAvatarURL: () => "https://example.com/bot.png"
        }
      }
    };

    await service.handleChannelAnalysisMessage(message as never);

    expect(timeout).not.toHaveBeenCalled();
    expect(calls.some((call) => call.query.includes("INSERT INTO alerts"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO moderation_actions"))).toBe(false);
  });
});
