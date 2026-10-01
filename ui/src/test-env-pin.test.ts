import { describe, expect, it } from "vitest";

// Bewaker van de `NODE_ENV`-pin in /app/ui/vitest.config.ts (REK-449).
// Zonder die pin sterft elke toets die `import { act } from "react"` doet op
// `TypeError: act is not a function`, zonder waarschuwing en zonder uitleg in de
// foutmelding. Deze toets faalt dan met een benoemde oorzaak in plaats van met
// honderden onleesbare rode toetsen. Verwijder de pin niet.
describe("vitest-omgeving", () => {
  it("draait met NODE_ENV=test, ook als de omgeving iets anders stuurt", () => {
    expect(process.env.NODE_ENV).toBe("test");
  });

  it("exporteert React act, dus de development-build is actief", async () => {
    const react = await import("react");
    expect(typeof react.act).toBe("function");
  });
});
