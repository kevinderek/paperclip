import type { IssueUnblockDescriptor } from "@paperclipai/shared";

/**
 * Parkeren van een taak: een mens zet zelf een issue op `blocked` ("In
 * afwachting") zonder dat er een blokkerende issue hoeft te zijn.
 *
 * De server weigert dat vanuit de agent-semantiek: bij `enteringBlocked` volgt
 * een 422 tenzij er een onopgeloste blokker, een pending interactie, een
 * pending approval of een `unblockDescriptor` is
 * (`server/src/routes/issues.ts`, het `enteringBlocked`-blok). De escape-hatch
 * `unblockDescriptor` zit al in het API-contract
 * (`packages/shared/src/validators/issue.ts`, `createIssueBaseSchema`); de UI
 * bood die alleen niet aan. Deze module levert die escape, in plaats van de
 * 422 te versoepelen.
 *
 * `PARK_ACTION_MAX` herhaalt de bovengrens uit dat schema, zodat de dialoog niet
 * meer kan sturen dan het contract accepteert.
 */
export const PARK_ACTION_MAX = 2_000;

/** Wie de geparkeerde taak eruit haalt. Agents komen hier niet in: dit is de UI. */
export type ParkOwnerChoice = "board" | "self";

/** Type-aliast, geen interface: de PATCH moet in `Record<string, unknown>` passen. */
export type ParkIssuePatch = {
  status: "blocked";
  unblockDescriptor: IssueUnblockDescriptor;
};

export type ParkPatchResult =
  | { ok: true; patch: ParkIssuePatch }
  | { ok: false; error: string };

/**
 * De PATCH voor één parkeerstap: `status: "blocked"` plus de descriptor in
 * hetzelfde verzoek, want de route accepteert de descriptor alleen samen met
 * die status (`unblockDescriptor requires blocked status`).
 *
 * De owner is `board` of `{ userId }`; de server accepteert beide voor een
 * gebruikers-actor en controleert alleen of een `userId` een actief lid van het
 * bedrijf is. `board` is daarom de standaard: die controle kan niet falen.
 */
export function buildParkIssuePatch(input: {
  owner: ParkOwnerChoice;
  action: string;
  currentUserId?: string | null;
}): ParkPatchResult {
  const action = input.action.trim();
  if (!action) {
    return { ok: false, error: "Say what has to happen before this can move on." };
  }
  if (action.length > PARK_ACTION_MAX) {
    return {
      ok: false,
      error: `Keep the action under ${PARK_ACTION_MAX} characters.`,
    };
  }
  if (input.owner === "self") {
    const userId = input.currentUserId?.trim();
    if (!userId) {
      return {
        ok: false,
        error: "Your account is not known here — pick the board instead.",
      };
    }
    return {
      ok: true,
      patch: { status: "blocked", unblockDescriptor: { owner: { userId }, action } },
    };
  }
  return {
    ok: true,
    patch: { status: "blocked", unblockDescriptor: { owner: "board", action } },
  };
}

/** De fouttekst van de server overnemen, zodat een afgewezen stap zichtbaar is. */
export function parkErrorMessage(error: unknown, fallback = "Status change failed."): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
