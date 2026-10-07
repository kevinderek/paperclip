import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

// The backfill has to release exactly the rows the fixed settle releases, and
// nothing more. The settle keeps released_at null for the whole workspace-restore
// class (WORKSPACE_RESTORE_FAILURE_CODES), because continuing such a run demands
// recorded workspaceRepairEvidence that no provider turn can supply. A backfill
// that excludes only one of the four codes releases holds the new sweep is built
// to keep - and it does so silently, on the day the column arrives.
const MIGRATION_FILE = "0290_issue_recovery_action_released_at.sql";
const RESTORE_FAILURE_CODES = [
  "restore_permission_denied",
  "restore_lock_timeout",
  "restore_unsafe_archive",
  "restore_failed",
] as const;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

function settledEvidence(workspaceRestoreFailure?: string) {
  return {
    runId: randomUUID(),
    ...(workspaceRestoreFailure ? { workspaceRestoreFailure } : {}),
    automaticRecovery: {
      policy: "preserve_without_replay_v1",
      replay: "blocked",
      actionOutcome: "unknown",
    },
  };
}

describeEmbeddedPostgres("issue recovery released_at migration", () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("releases only the settled holds the fixed settle would release", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-released-at-backfill-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => sql.end());

    // Rewind to the pre-migration state: the column arrives with this test.
    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;
    await sql`ALTER TABLE "issue_recovery_actions" DROP COLUMN IF EXISTS "released_at"`;

    const companyId = randomUUID();
    await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyId}, 'Backfill', 'BFL')`;

    const seeded: Array<{ label: string; id: string; expectReleased: boolean }> = [];
    const cases = [
      ...RESTORE_FAILURE_CODES.map((code) => ({ label: code, code, expectReleased: false })),
      { label: "no restore failure", code: null as string | null, expectReleased: true },
    ];
    for (const [index, testCase] of cases.entries()) {
      const issueId = randomUUID();
      const actionId = randomUUID();
      await sql`INSERT INTO "issues" ("id", "company_id", "title", "status") VALUES (${issueId}, ${companyId}, ${`Houd ${testCase.label}`}, 'blocked')`;
      await sql`
        INSERT INTO "issue_recovery_actions"
          ("id", "company_id", "source_issue_id", "kind", "status", "owner_type", "cause",
           "fingerprint", "evidence", "next_action", "outcome", "resolved_at", "created_at", "updated_at")
        VALUES (
          ${actionId}, ${companyId}, ${issueId}, 'active_run_watchdog', 'resolved', 'board',
          'legacy_execution_requires_reconciliation', ${`legacy-execution:seed-${index}`},
          ${sql.json(settledEvidence(testCase.code ?? undefined))},
          'Inspect the stopped provider and recorded actions.',
          'blocked', '2026-10-05T20:15:54.000Z', '2026-10-05T20:15:54.000Z', '2026-10-05T20:15:54.000Z'
        )
      `;
      seeded.push({ label: testCase.label, id: actionId, expectReleased: testCase.expectReleased });
    }

    await applyPendingMigrations(database.connectionString, [MIGRATION_FILE]);

    const released = await sql<{ id: string; released_at: Date | null }[]>`
      SELECT "id", "released_at" FROM "issue_recovery_actions" WHERE "company_id" = ${companyId}
    `;
    // One assertion over every case: a run that stops at the first mismatch hides
    // how wide the defect is, and each of these runs pays for a cold postgres.
    const actual = seeded.map((row) => {
      const value = released.find((candidate) => candidate.id === row.id)?.released_at ?? null;
      const isReleased = value !== null;
      return { label: row.label, expected: row.expectReleased ? "released" : "held", actual: isReleased ? "released" : "held" };
    });
    expect(actual).toEqual(actual.map((row) => ({ ...row, actual: row.expected })));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});