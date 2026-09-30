/**
 * Herbenoemde weergavelabels voor issue-statussen.
 *
 * De opgeslagen waarde blijft ongewijzigd (`blocked` blijft `blocked`); alleen
 * wat de gebruiker leest verandert. De gedragskant — actieve status, wel of
 * niet in `INBOX_MINE_ISSUE_STATUSES`, wel of niet oppakbaar door een agent —
 * blijft ongemoeid.
 *
 * Sommige oppervlakken lezen hun eigen woordenschatel (`todo: "Todo"` in de
 * lijst tegenover `todo: "To Do"` in de grafiek) en andere leiden de naam
 * mechanisch af uit de waarde. Die bestaande verschillen horen hier niet bij:
 * de kaart hieronder is de enige plek waar een statuslabel een eigen naam
 * krijgt, zodat de lijsten en de afleiders niet uit elkaar kunnen lopen.
 */

/** Weergavelabel van de issue-status `blocked`. */
export const BLOCKED_STATUS_LABEL = "In afwachting";

/** Statuswaarde -> weergavelabel, voor alles wat de waarde mechanisch afleidt. */
export const ISSUE_STATUS_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
  blocked: BLOCKED_STATUS_LABEL,
};

/**
 * Geeft het herbenoemde label voor `status`, of `undefined` als de aanroeper
 * zijn eigen afleiding mag houden. Bewust een override en geen volledige
 * woordenschatel: de afleiders verschillen onderling in woordkeuze en
 * hoofdletters, en die moet hier niet onbedoeld vereenvoudigd worden.
 */
export function issueStatusLabelOverride(status: string): string | undefined {
  return ISSUE_STATUS_LABEL_OVERRIDES[status];
}