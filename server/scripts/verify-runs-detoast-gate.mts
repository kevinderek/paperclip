/**
 * Poort voor de `/runs`-detoast-fix.
 *
 * Vergelijkt de rij-output van de live queryvorm (losse `->`, zoals die vóór de
 * fix in `server/src/services/activity.ts` stond) met de gefixte vorm
 * (`jsonb_each`-lateral, `detoastedJsonbKeys`). De verwachting is een **literal**:
 * de kolomvolgorde en de projectievelden van de vóór-fix-query, gemeten en
 * bewaard in `runs-reference-query.json`. Niet uit de code onder test, want dan
 * vergelijkt de poort de mutant met zichzelf.
 *
 * Gebruik:
 *   PAPERCLIP_COMPANY_ID=… REK_ISSUE_ID=<issue-uuid> tsx server/scripts/verify-runs-detoast-gate.mts
 *
 * Exit 0 = identiek, exit 1 = afwijking (en welke).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { closeRegisteredClients, createDb } from "@paperclipai/db";
import { activityService } from "../src/services/activity.js";

const companyId = process.env.PAPERCLIP_COMPANY_ID;
const issueId = process.env.REK_ISSUE_ID;
const databaseUrl = process.env.DATABASE_URL;
if (!companyId || !issueId || !databaseUrl) {
  console.error("mist PAPERCLIP_COMPANY_ID, REK_ISSUE_ID of DATABASE_URL");
  process.exit(2);
}

const referencePath = fileURLToPath(new URL("./runs-reference-query.json", import.meta.url));
const reference = JSON.parse(readFileSync(referencePath, "utf8")) as { columns: string[] };

const db = createDb(databaseUrl, { maxConnections: 2 });

// De vóór-fix-vorm, letterlijk overgenomen uit de commit vóór de fix.
const VOUW = sql`
  select hr.id::text as run_id, hr.created_at, hr.log_bytes,
    hr.context_snapshot -> 'wakeCommentIds' as c1,
    hr.context_snapshot ->> 'wakeCommentId' as c2,
    hr.context_snapshot ->> 'commentId' as c3,
    hr.context_snapshot ->> 'issueId' as c4,
    case when hr.usage_json is null then null else jsonb_strip_nulls(jsonb_build_object(
      'inputTokens', coalesce(hr.usage_json -> 'inputTokens', hr.usage_json -> 'input_tokens'),
      'input_tokens', coalesce(hr.usage_json -> 'input_tokens', hr.usage_json -> 'inputTokens'),
      'outputTokens', coalesce(hr.usage_json -> 'outputTokens', hr.usage_json -> 'output_tokens'),
      'output_tokens', coalesce(hr.usage_json -> 'output_tokens', hr.usage_json -> 'outputTokens'),
      'cachedInputTokens', coalesce(hr.usage_json -> 'cachedInputTokens', hr.usage_json -> 'cached_input_tokens', hr.usage_json -> 'cache_read_input_tokens'),
      'cached_input_tokens', coalesce(hr.usage_json -> 'cached_input_tokens', hr.usage_json -> 'cachedInputTokens', hr.usage_json -> 'cache_read_input_tokens'),
      'cache_read_input_tokens', coalesce(hr.usage_json -> 'cache_read_input_tokens', hr.usage_json -> 'cached_input_tokens', hr.usage_json -> 'cachedInputTokens'),
      'billingType', coalesce(hr.usage_json -> 'billingType', hr.usage_json -> 'billing_type'),
      'billing_type', coalesce(hr.usage_json -> 'billing_type', hr.usage_json -> 'billingType'),
      'costUsd', coalesce(hr.usage_json -> 'costUsd', hr.usage_json -> 'cost_usd', hr.usage_json -> 'total_cost_usd'),
      'cost_usd', coalesce(hr.usage_json -> 'cost_usd', hr.usage_json -> 'costUsd', hr.usage_json -> 'total_cost_usd'),
      'total_cost_usd', coalesce(hr.usage_json -> 'total_cost_usd', hr.usage_json -> 'cost_usd', hr.usage_json -> 'costUsd'))) end as usage_json,
    case when hr.result_json is null then null else jsonb_strip_nulls(jsonb_build_object(
      'conversationReset', hr.result_json -> 'conversationReset',
      'workspaceRestoreFailure', case when hr.result_json ->> 'workspaceRestoreFailure'
        in ('restore_permission_denied', 'restore_lock_timeout', 'restore_unsafe_archive', 'restore_failed')
        then hr.result_json -> 'workspaceRestoreFailure' end,
      'workspaceRestorePath', case when length(hr.result_json ->> 'workspaceRestorePath') <= 180
        then hr.result_json -> 'workspaceRestorePath' end,
      'finalResponseRecorded', case when jsonb_typeof(hr.result_json -> 'finalResponseRecorded') = 'boolean'
        then hr.result_json -> 'finalResponseRecorded' end,
      'billingType', coalesce(hr.result_json -> 'billingType', hr.result_json -> 'billing_type'),
      'billing_type', coalesce(hr.result_json -> 'billing_type', hr.result_json -> 'billingType'),
      'costUsd', coalesce(hr.result_json -> 'costUsd', hr.result_json -> 'cost_usd', hr.result_json -> 'total_cost_usd'),
      'cost_usd', coalesce(hr.result_json -> 'cost_usd', hr.result_json -> 'costUsd', hr.result_json -> 'total_cost_usd'),
      'total_cost_usd', coalesce(hr.result_json -> 'total_cost_usd', hr.result_json -> 'cost_usd', hr.result_json -> 'costUsd'),
      'stopReason', hr.result_json -> 'stopReason',
      'effectiveTimeoutSec', hr.result_json -> 'effectiveTimeoutSec',
      'effectiveTimeoutMs', hr.result_json -> 'effectiveTimeoutMs',
      'timeoutConfigured', hr.result_json -> 'timeoutConfigured',
      'timeoutSource', hr.result_json -> 'timeoutSource',
      'timeoutFired', hr.result_json -> 'timeoutFired')) end as result_json
  from heartbeat_runs hr
  inner join agents a on a.id = hr.agent_id and a.company_id = hr.company_id
  where hr.company_id = ${companyId}
    and (hr.context_snapshot ->> 'issueId' = ${issueId}
      or exists (
        select 1 from activity_log al
        where al.company_id = ${companyId} and al.entity_type = 'issue'
          and al.entity_id = ${issueId} and al.run_id = hr.id
      ))
  order by hr.created_at desc
`;

const oud = (await db.execute(VOUW)) as unknown as Record<string, unknown>[];

// De gefixte vorm, uit de echte service, zodat de poort de productiecode meet.
const nieuw = (await activityService(db).runsForIssue(companyId, issueId)) as unknown as Record<string, unknown>[];
await closeRegisteredClients(databaseUrl);

/**
 * `db.execute` geeft de rij terug zoals postgres.js hem levert: een timestamp als
 * tekst, een bigint-kolom als string. De service geeft een `Date` en een number.
 * Zonder deze drie regels is de poort niet over de projectie maar over de
 * driver-kopers, en zou elke mutatie groen melden.
 */
const gelijkWaarde = (a: unknown, b: unknown) => {
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  if (a instanceof Date && typeof b === "string") return a.getTime() === new Date(b).getTime();
  if (typeof a === "string" && b instanceof Date) return new Date(a).getTime() === b.getTime();
  if (typeof a === "string" && typeof b === "number") return Number(a) === b;
  if (typeof a === "number" && typeof b === "string") return a === Number(b);
  return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * De vóór-fix-query noemt de context-sleutels `c1..c4`, de service noemt ze
 * `wakeCommentIds` enz. De sleutel wordt gekozen op aanwezigheid, niet met `??`:
 * een JSON-null in de service is `null`, en `??` zou dan doorschuiven naar de
 * ontbrekende `c1` en `undefined` vergelijken in plaats van `null`.
 */
const projectie = (row: Record<string, unknown>, nieuw: boolean) => (nieuw ? {
  run_id: row.runId,
  created_at: row.createdAt,
  log_bytes: row.logBytes,
  c1: row.wakeCommentIds,
  c2: row.wakeCommentId,
  c3: row.contextCommentId,
  c4: row.contextIssueId,
  usage_json: row.usageJson,
  result_json: row.resultJson,
} : {
  run_id: row.run_id,
  created_at: row.created_at,
  log_bytes: row.log_bytes,
  c1: row.c1,
  c2: row.c2,
  c3: row.c3,
  c4: row.c4,
  usage_json: row.usage_json,
  result_json: row.result_json,
});

const sleutels = reference.columns;
if (sleutels.length !== Object.keys(projectie(nieuw[0] ?? {}, true)).length) {
  console.error(`referentie heeft ${sleutels.length} kolommen, de gefixte rij ${Object.keys(projectie(nieuw[0] ?? {}, true)).length}`);
  process.exit(2);
}

let identiek = 0;
const afwijkingen: string[] = [];
for (let i = 0; i < Math.max(oud.length, nieuw.length); i++) {
  const a = oud[i] ? projectie(oud[i] as Record<string, unknown>, false) : null;
  const b = nieuw[i] ? projectie(nieuw[i] as Record<string, unknown>, true) : null;
  if (a && b && sleutels.every((k) => gelijkWaarde(a[k], b[k]))) identiek++;
  else if (a && b) {
    const verschil = sleutels.filter((k) => !gelijkWaarde(a[k], b[k]));
    afwijkingen.push(`rij ${i}: velden ${verschil.join(", ")}\n      oud:  ${verschil.map((k) => `${k}=${JSON.stringify(a[k])}`).join(" ")}\n      nieuw: ${verschil.map((k) => `${k}=${JSON.stringify(b[k])}`).join(" ")}`);
  } else afwijkingen.push(`rij ${i}: ${a ? "ontbreekt in fix" : "ontbreekt in vóór-fix"}`);
}

console.log(`${identiek}/${Math.max(oud.length, nieuw.length)} rijen hebben alle ${sleutels.length} projectievelden identiek`);
for (const l of afwijkingen.slice(0, 5)) console.log(`  ${l}`);
if (afwijkingen.length) {
  console.error("ROOD: de gefixte query levert een andere projectie dan de referentie");
  process.exit(1);
}
console.log("GROEN");
process.exit(0);
