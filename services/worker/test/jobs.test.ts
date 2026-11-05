import { describe, expect, it } from "vitest";

import { checkUnprovenActions } from "../src/jobs";

function createSqlMock(responses: unknown[] = []) {
  const calls: Array<{ query: string; values: unknown[] }> = [];

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ query: strings.join("?"), values });
    return Promise.resolve((responses.shift() as unknown) ?? []);
  }) as never;

  return { sql, calls };
}

describe("checkUnprovenActions", () => {
  it("matches proof messages posted within five minutes and clears stale unproven rows", async () => {
    const action = {
      id: "action-1",
      guild_id: "guild-1",
      actor_id: "actor-1",
      target_id: "target-1",
      created_at: new Date("2026-04-14T12:00:00.000Z")
    };
    const { sql, calls } = createSqlMock([[action], [{ id: "proof-1" }], [], []]);

    await checkUnprovenActions(sql);

    expect(calls[0]?.query).toContain("FROM unproven_actions ua");
    expect(calls[0]?.values[0]).toBe(5);
    const proofMatchCall = calls.find((call) => call.query.includes("UPDATE moderation_proof_messages"));
    expect(proofMatchCall?.query).toContain("action_id IS NULL");
    expect(proofMatchCall?.values.at(-1)).toBe(5);
    expect(calls.some((call) => call.query.includes("DELETE FROM unproven_actions"))).toBe(true);
    expect(calls.some((call) => call.query.includes("INSERT INTO unproven_actions"))).toBe(false);
  });

  it("creates an unproven action only after the five-minute proof window expires", async () => {
    const action = {
      id: "action-2",
      guild_id: "guild-1",
      actor_id: "actor-2",
      target_id: "target-2",
      created_at: new Date("2026-04-14T12:05:00.000Z")
    };
    const { sql, calls } = createSqlMock([[], [action], [], []]);

    await checkUnprovenActions(sql);

    const pendingActionCall = calls.find((call) => call.query.includes("NOW() - ? * INTERVAL '1 minute'"));
    expect(pendingActionCall?.values[0]).toBe(5);
    expect(calls.some((call) => call.query.includes("DELETE FROM unproven_actions"))).toBe(false);
    expect(calls.some((call) => call.query.includes("INSERT INTO unproven_actions"))).toBe(true);
  });
});
