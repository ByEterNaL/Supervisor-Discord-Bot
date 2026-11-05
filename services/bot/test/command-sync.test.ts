import { beforeEach, describe, expect, it, vi } from "vitest";

const restState = {
  puts: [] as Array<{ route: string; body: unknown }>
};

vi.mock("discord.js", () => {
  class REST {
    setToken() {
      return this;
    }

    async put(route: string, payload: { body: unknown }) {
      restState.puts.push({ route, body: payload.body });
      if (Array.isArray(payload.body)) {
        return payload.body;
      }
      return [];
    }
  }

  const Routes = {
    applicationCommands: (applicationId: string) => `global:${applicationId}`,
    applicationGuildCommands: (applicationId: string, guildId: string) =>
      `guild:${applicationId}:${guildId}`
  };

  return { REST, Routes };
});

import { syncApplicationCommands } from "../src/lib/command-sync";

describe("syncApplicationCommands", () => {
  beforeEach(() => {
    restState.puts = [];
  });

  it("clears global commands and bulk-syncs guild commands via PUT", async () => {
    const guildCommands = [
      {
        name: "rank",
        description: "Rank kartı",
        type: 1,
        options: []
      },
      {
        name: "yardım",
        description: "Komut rehberi",
        type: 1,
        options: []
      }
    ];

    const result = await syncApplicationCommands({
      token: "token",
      applicationId: "app-1",
      guildId: "guild-1",
      guildCommands
    });

    expect(result.global.deleted).toBe(0);
    expect(result.guild.created).toBe(2);
    expect(restState.puts).toEqual([
      { route: "global:app-1", body: [] },
      { route: "guild:app-1:guild-1", body: guildCommands }
    ]);
  });
});
