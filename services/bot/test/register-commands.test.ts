import { describe, expect, it } from "vitest";

import { buildCommandDefinitions, helpCommandName } from "../src/lib/register-commands";

describe("command registration", () => {
  it("registers the moderson setup command", () => {
    const definitions = buildCommandDefinitions();
    const moderson = definitions.find((item) => item.name === "moderson");

    expect(moderson).toBeDefined();
    expect(moderson?.options?.[0]?.name).toBe("kurulum");
    expect(moderson?.options?.some((item) => item.name === "kaldir")).toBe(true);
  });

  it("registers the help command", () => {
    const definitions = buildCommandDefinitions();
    const helpCommand = definitions.find((item) => item.name === helpCommandName);

    expect(helpCommand).toBeDefined();
  });
});
