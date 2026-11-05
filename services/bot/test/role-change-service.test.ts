import { Collection } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { RoleChangeService } from "../src/services/role-change-service";

function createSqlMock() {
  const calls: Array<{ query: string; values: unknown[] }> = [];

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join("?"), values });
    return Promise.resolve([]);
  }) as never;

  return { sql, calls };
}

describe("RoleChangeService member role history", () => {
  it("records role assignments and removals from guildMemberUpdate", async () => {
    const { sql, calls } = createSqlMock();
    const memberService = {
      syncUserShell: vi.fn().mockResolvedValue(undefined)
    };
    const logger = {
      warn: vi.fn()
    };
    const service = new RoleChangeService(sql, logger as never, memberService as never);

    const guild = {
      id: "guild-1",
      fetchAuditLogs: vi.fn().mockResolvedValue({
        entries: new Collection([
          [
            "audit-1",
            {
              id: "audit-1",
              targetId: "member-1",
              createdAt: new Date(),
              executorId: "staff-1",
              executor: {
                id: "staff-1",
                username: "Supervisor",
                displayAvatarURL: () => "https://example.com/avatar.png"
              },
              reason: "manual update",
              changes: [
                { key: "$add", new: [{ id: "role-new", name: "Yeni Rol" }] },
                { key: "$remove", new: [{ id: "role-old", name: "Eski Rol" }] }
              ]
            }
          ]
        ])
      })
    };

    const oldMember = {
      id: "member-1",
      guild,
      user: { username: "TargetUser" },
      displayName: "Target User",
      roles: {
        cache: new Collection([
          [
            "role-old",
            {
              id: "role-old",
              name: "Eski Rol"
            }
          ]
        ])
      }
    };
    const newMember = {
      id: "member-1",
      guild,
      user: { username: "TargetUser" },
      displayName: "Target User",
      roles: {
        cache: new Collection([
          [
            "role-new",
            {
              id: "role-new",
              name: "Yeni Rol"
            }
          ]
        ])
      }
    };

    await service.handleMemberRoleUpdate(oldMember as never, newMember as never);

    expect(guild.fetchAuditLogs).toHaveBeenCalledTimes(1);
    expect(memberService.syncUserShell).toHaveBeenCalledWith(
      "guild-1",
      expect.objectContaining({ id: "staff-1", username: "Supervisor" }),
      "user"
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.values).toContain("assign");
    expect(calls[1]?.values).toContain("unassign");
    expect(String(calls[0]?.values[8])).toContain("\"targetMember\"");
    expect(String(calls[1]?.values[9])).toContain("audit-1:unassign:role-old");
  });
});
