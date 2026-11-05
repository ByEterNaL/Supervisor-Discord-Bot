import { describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../../../packages/shared/src";
import { ModerationCommandService } from "../src/services/moderation-command-service";

function createSqlMock() {
  return ((strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve([])) as never;
}

function createConfig() {
  return {
    ...defaultConfig,
    moderation: {
      ...defaultConfig.moderation,
      jailRoleId: "jail-role",
      purgeMaxLimit: 50,
      defaultWarnPoints: 3
    }
  };
}

describe("ModerationCommandService draft builders", () => {
  it("uses the configured default warn points when the command omits a point value", async () => {
    const service = new ModerationCommandService(
      createSqlMock(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      {
        canWarn: vi.fn().mockReturnValue(true)
      } as never,
      createConfig
    ) as any;

    const interaction = {
      guildId: "guild-1",
      guild: {
        id: "guild-1",
        ownerId: "owner-1",
        members: {
          fetch: vi.fn().mockResolvedValue({
            id: "user-2",
            displayName: "Hedef Uye",
            moderatable: true,
            roles: { highest: { position: 1 } }
          })
        }
      },
      options: {
        getUser: vi.fn().mockReturnValue({ id: "user-2", tag: "hedef#0001" }),
        getString: vi.fn().mockReturnValue("Flood"),
        getInteger: vi.fn().mockReturnValue(null),
        getBoolean: vi.fn().mockReturnValue(null)
      },
      reply: vi.fn()
    };
    const actor = {
      id: "actor-1",
      guild: { ownerId: "owner-1" },
      roles: { highest: { position: 10 } }
    };

    const draft = await service.buildWarnDraft(interaction, actor);

    expect(draft).not.toBeNull();
    expect(draft.points).toBe(3);
    expect(draft.caseType).toBe("warn");
    expect(draft.dmRequested).toBe(true);
  });

  it("caps purge limit using the configured moderation purge maximum", async () => {
    const service = new ModerationCommandService(
      createSqlMock(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      {
        canModerateMessages: vi.fn().mockReturnValue(true)
      } as never,
      createConfig
    ) as any;

    const interaction = {
      options: {
        getInteger: vi.fn().mockImplementation((name: string) => (name === "sayi" ? 120 : null)),
        getUser: vi.fn().mockReturnValue(null),
        getBoolean: vi.fn().mockReturnValue(false),
        getChannel: vi.fn().mockReturnValue(null)
      },
      channel: {
        id: "channel-1",
        name: "genel",
        messages: { fetch: vi.fn() },
        bulkDelete: vi.fn()
      },
      reply: vi.fn()
    };
    const actor = { id: "actor-1" };

    const draft = await service.buildPurgeDraft(interaction, actor);

    expect(draft).not.toBeNull();
    expect(draft.metadata.limit).toBe(50);
    expect(draft.targetType).toBe("channel");
  });
});
