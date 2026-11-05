import { describe, expect, it } from "vitest";

import { rankProgress, resolveRewardRoleIds } from "../../../packages/shared/src";

describe("rank helpers", () => {
  it("calculates level progress from total xp", () => {
    const progress = rankProgress(150, {
      baseXp: 100,
      linearXp: 35,
      quadraticXp: 10
    });

    expect(progress.level).toBe(1);
    expect(progress.currentLevelXp).toBe(50);
    expect(progress.nextLevelXp).toBe(145);
    expect(progress.progressPercent).toBe(34);
  });

  it("resolves reward roles in highest-only and stacking mode", () => {
    const rewards = [
      { level: 5, roleId: "role-5" },
      { level: 10, roleId: "role-10" },
      { level: 20, roleId: "role-20" }
    ];

    expect(resolveRewardRoleIds(12, rewards, "highest_only")).toEqual(["role-10"]);
    expect(resolveRewardRoleIds(12, rewards, "stacking")).toEqual(["role-5", "role-10"]);
  });
});
