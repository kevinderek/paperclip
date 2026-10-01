import { describe, expect, it } from "vitest";
import { updateIssueSchema } from "@paperclipai/shared";
import { buildParkIssuePatch, PARK_ACTION_MAX, parkErrorMessage } from "./park-issue";

/**
 * De parkeerstap is de escape die de server al accepteert. Deze tests leggen
 * vast dát de UI die escape daadwerkelijk meestuurt: de PATCH die de picker
 * bouwt moet door het API-contract (`updateIssueSchema`, dezelfde validator als
 * de route) en moet `unblockDescriptor` dragen, want zonder die descriptor
 * weigert de server `blocked` voor een taak zonder blokker (de 422 op
 * `enteringBlocked` in `server/src/routes/issues.ts`).
 */
describe("buildParkIssuePatch", () => {
  it("sends status and unblockDescriptor in one patch, validated by the API contract", () => {
    const result = buildParkIssuePatch({
      owner: "board",
      action: "Wachten op de prijslijst van de leverancier.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch).toEqual({
      status: "blocked",
      unblockDescriptor: {
        owner: "board",
        action: "Wachten op de prijslijst van de leverancier.",
      },
    });
    // De 422-vrije route: het contract dat de route zelf ook afloopt.
    expect(updateIssueSchema.safeParse(result.patch).success).toBe(true);
  });

  it("names the signed-in user when the human takes it out of waiting themselves", () => {
    const result = buildParkIssuePatch({
      owner: "self",
      action: "Ik pak dit op na de vakantie.",
      currentUserId: "user-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.unblockDescriptor.owner).toEqual({ userId: "user-1" });
    expect(updateIssueSchema.safeParse(result.patch).success).toBe(true);
  });

  it("refuses the self owner without a known user instead of sending an unusable owner", () => {
    const result = buildParkIssuePatch({
      owner: "self",
      action: "Ik pak dit op.",
      currentUserId: null,
    });

    expect(result.ok).toBe(false);
  });

  it("requires an action and trims it", () => {
    expect(buildParkIssuePatch({ owner: "board", action: "   " }).ok).toBe(false);

    const result = buildParkIssuePatch({ owner: "board", action: "  Wachten.  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.unblockDescriptor.action).toBe("Wachten.");
  });

  it("stays inside the action bound the contract sets", () => {
    expect(
      buildParkIssuePatch({ owner: "board", action: "x".repeat(PARK_ACTION_MAX) }).ok,
    ).toBe(true);
    expect(
      buildParkIssuePatch({ owner: "board", action: "x".repeat(PARK_ACTION_MAX + 1) }).ok,
    ).toBe(false);
  });
});

describe("parkErrorMessage", () => {
  it("keeps the server text, so a refused status change is readable", () => {
    expect(
      parkErrorMessage(
        new Error(
          "Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor",
        ),
      ),
    ).toContain("Entering blocked requires");
  });

  it("falls back when there is no message to show", () => {
    expect(parkErrorMessage(null)).toBe("Status change failed.");
    expect(parkErrorMessage(new Error(""))).toBe("Status change failed.");
  });
});
