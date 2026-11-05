import { Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { StaffMessageAuditService } from "../src/services/staff-message-audit-service";

function createSqlMock(responses: unknown[] = []) {
  const calls: Array<{ query: string; values: unknown[] }> = [];

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join("?"), values });
    return Promise.resolve((responses.shift() as unknown) ?? []);
  }) as never;

  return { sql, calls };
}

describe("StaffMessageAuditService", () => {
  it("records edit events for tracked staff messages", async () => {
    const existingState = {
      message_id: "message-1",
      guild_id: "guild-1",
      channel_id: "channel-1",
      channel_name: "genel",
      author_id: "staff-1",
      author_display_name: "Supervisor",
      author_avatar_url: "https://example.com/avatar.png",
      content: "ilk içerik",
      attachment_urls: [],
      message_created_at: new Date("2026-03-18T00:00:00.000Z")
    };
    const { sql, calls } = createSqlMock([[existingState], [], []]);
    const memberService = {
      getMemberType: vi.fn().mockReturnValue("staff"),
      syncMember: vi.fn().mockResolvedValue(undefined)
    };
    const logger = { warn: vi.fn() };
    const service = new StaffMessageAuditService(sql, logger as never, memberService as never);

    const guild = {
      id: "guild-1",
      members: {
        fetch: vi.fn().mockResolvedValue(null)
      }
    };
    const member = {
      id: "staff-1",
      displayName: "Supervisor",
      displayAvatarURL: () => "https://example.com/avatar.png"
    };
    const newMessage = {
      id: "message-1",
      partial: false,
      inGuild: () => true,
      guild,
      guildId: "guild-1",
      author: { bot: false, id: "staff-1" },
      member,
      channelId: "channel-1",
      channel: { name: "genel" },
      attachments: new Collection(),
      content: "yeni içerik",
      createdAt: new Date("2026-03-18T00:00:00.000Z"),
      editedAt: new Date("2026-03-18T00:10:00.000Z")
    };

    await service.handleMessageUpdate(newMessage as never, newMessage as never);

    expect(memberService.syncMember).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.query.includes("INSERT INTO staff_message_events"))).toBe(true);
    expect(calls.some((call) => call.values.includes("ilk içerik"))).toBe(true);
    expect(calls.some((call) => call.values.includes("yeni içerik"))).toBe(true);
  });

  it("records delete events from stored message state", async () => {
    const existingState = {
      message_id: "message-2",
      guild_id: "guild-1",
      channel_id: "channel-2",
      channel_name: "log",
      author_id: "staff-2",
      author_display_name: "Denetçi",
      author_avatar_url: null,
      content: "silinecek içerik",
      attachment_urls: [],
      message_created_at: new Date("2026-03-18T00:00:00.000Z")
    };
    const { sql, calls } = createSqlMock([[existingState], [], []]);
    const memberService = {
      getMemberType: vi.fn(),
      syncMember: vi.fn()
    };
    const logger = { warn: vi.fn() };
    const service = new StaffMessageAuditService(sql, logger as never, memberService as never);

    await service.handleMessageDelete({
      id: "message-2",
      guildId: "guild-1"
    } as never);

    expect(calls.some((call) => call.values.includes("silinecek içerik"))).toBe(true);
    expect(calls.some((call) => call.query.includes("UPDATE staff_message_states"))).toBe(true);
  });
});
