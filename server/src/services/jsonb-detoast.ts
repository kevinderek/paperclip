import { sql, type Column, type SQL } from "drizzle-orm";

/**
 * Eén TOAST-detoast per brede jsonb-kolom, in plaats van één per sleutel.
 *
 * Een TOASTed jsonb-kolom ligt op schijf zodra hij boven de ~2 kB TOAST-drempel
 * gaat, en PostgreSQL leest de volledige waarde opnieuw uit de TOAST-store bij
 * elke `->` of `->>`. De `/runs`-route las 31 sleutels uit drie kolommen, dus 31
 * volledige detoasts per rij: gemeten ~380 ms per extra deref op
 * `heartbeat_runs.context_snapshot` (mediaan 348 ms voor de eerste, 379 ms voor
 * de tweede, 396 ms voor de derde).
 *
 * `jsonb_each` leest de kolom één keer en levert alle sleutels uit het geheugen.
 * Dat is dezelfde aanpak als de `jsonb_each`-poort in
 * `server/scripts/verify-runs-pre-detoast-gate.mts`.
 *
 * Semantiek is identiek aan `col -> 'key'` (jsonb) en `col ->> 'key'` (tekst).
 * Gemeten over alle 2.419 rijen van `heartbeat_runs`, voor elk van de dertien
 * gelezen sleutels: 0 afwijkingen.
 */
export function detoastedJsonbKeys(
  column: Column | SQL,
  keys: readonly string[],
  alias: string,
) {
  const keyList = keys.map((key) => `'${key}'`).join(", ");
  const projections = keys
    .map((key) => `(array_agg(e.value) filter (where e.key = '${key}'))[1] as "${key}"`)
    .join(", ");
  const join = sql`lateral (select ${sql.raw(projections)} from jsonb_each(case when ${column} is null then '{}'::jsonb else ${column} end) e where e.key in (${sql.raw(keyList)})) ${sql.raw(alias)}`;
  return {
    join,
    /** De jsonb-waarde van één sleutel, gelijk aan `col -> 'key'`. */
    jsonb: (key: string): SQL => sql.raw(`${alias}."${key}"`),
    /** De tekstwaarde van één sleutel, gelijk aan `col ->> 'key'`. */
    text: (key: string): SQL => sql.raw(`${alias}."${key}" #>> '{}'`),
  };
}