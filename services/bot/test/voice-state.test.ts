import { describe, expect, it } from "vitest";

import {
  defaultConfig,
  isCameraActive,
  isStreamActive,
  isVoiceActive
} from "../../../packages/shared/src";
import type { SupervisorConfig } from "../../../packages/shared/src";
import {
  buildBaseTicketOverwrites,
  buildClaimedTicketOverwrites
} from "../src/services/ticket-service";

describe("voice tracking helpers", () => {
  const config = {
    afkChannelId: "999",
    ignoredChannelIds: ["777"],
    ignoredCategoryIds: ["555"]
  };

  it("counts active voice only when not muted or deafened", () => {
    expect(
      isVoiceActive(
        {
          channelId: "123",
          parentId: null,
          selfMute: false,
          serverMute: false,
          selfDeaf: false,
          serverDeaf: false,
          streaming: false,
          selfVideo: false
        },
        config
      )
    ).toBe(true);

    expect(
      isVoiceActive(
        {
          channelId: "123",
          parentId: null,
          selfMute: true,
          serverMute: false,
          selfDeaf: false,
          serverDeaf: false,
          streaming: false,
          selfVideo: false
        },
        config
      )
    ).toBe(false);
  });

  it("ignores afk and ignored channels", () => {
    expect(
      isVoiceActive(
        {
          channelId: "999",
          parentId: null,
          selfMute: false,
          serverMute: false,
          selfDeaf: false,
          serverDeaf: false,
          streaming: false,
          selfVideo: false
        },
        config
      )
    ).toBe(false);

    expect(
      isCameraActive(
        {
          channelId: "777",
          parentId: null,
          selfMute: false,
          serverMute: false,
          selfDeaf: false,
          serverDeaf: false,
          streaming: false,
          selfVideo: true
        },
        config
      )
    ).toBe(false);

    expect(
      isStreamActive(
        {
          channelId: "123",
          parentId: "555",
          selfMute: false,
          serverMute: false,
          selfDeaf: false,
          serverDeaf: false,
          streaming: true,
          selfVideo: false
        },
        config
      )
    ).toBe(false);
  });
});

describe("ticket permission builders", () => {
  const config: SupervisorConfig = {
    ...defaultConfig,
    roles: {
      ...defaultConfig.roles,
      staffRoleIds: ["staff-1", "staff-2"],
      upperStaffRoleIds: ["upper-1"],
      supervisorRoleIds: ["sup-1"],
      banRoleIds: [],
      kickRoleIds: []
    },
    voice: {
      ...defaultConfig.voice,
    }
  };

  it("includes support roles before claim and narrows visibility after claim", () => {
    const base = buildBaseTicketOverwrites("everyone", "owner", config);
    const claimed = buildClaimedTicketOverwrites("everyone", "owner", "claimer", config);

    expect(base.some((entry) => entry.id === "staff-1")).toBe(true);
    expect(claimed.some((entry) => entry.id === "claimer")).toBe(true);
    expect(
      claimed.some(
        (entry) => entry.id === "staff-1" && Array.isArray(entry.deny) && entry.deny.length > 0
      )
    ).toBe(true);
  });
});
