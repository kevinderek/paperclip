import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";

// A recovery row that recorded its own no-replay disposition used to keep the
// issue on blocked forever: the blocker predicate read the replay flag without
// a release marker, so an interrupted run turned every later retry into a
// cancelled stale queue. These cases pin the material that bug runs on - the
// settled row and its released_at - and not the status field that already had
// a test.
const externalDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
const support = externalDatabaseUrl
  ? { supported: true }
  : await getEmbeddedPostgresTestSupport();

const INTERRUPTED_RUN = { status: "interrupted", errorCode: "operator_interrupt" } as const;

async function seedIssue(input: {
  db: ReturnType<typeof createDb>;
  companyId: string;
  agentId: string;
  status: string;
  previousRunId: string;
}): Promise<string> {
  const issueId = randomUUID();
  await input.db.insert(issues).values({
    id: issueId,
    companyId: input.companyId,
    title: "Interrupted execution that has to stay workable",
    status: input.status,
    priority: "high",
    assigneeAgentId: input.agentId,
  });
  await input.db.insert(heartbeatRuns).values({
    id: input.previousRunId,
    companyId: input.companyId,
    agentId: input.agentId,
    status: INTERRUPTED_RUN.status,
    errorCode: INTERRUPTED_RUN.errorCode,
    contextSnapshot: { issueId },
  });
  return issueId;
}

async function seedCompanyAndAgent(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
    defaultResponsibleUserId: "responsible-user",
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "CodexCoder",
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
    permissions: {},
  });
  return { companyId, agentId };
}

function interruptionHold(input: {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  status: "active" | "resolved";
  evidence?: Record<string, unknown>;
  releasedAt?: Date | null;
  nextAction?: string;
}) {
  return {
    companyId: input.companyId,
    sourceIssueId: input.issueId,
    kind: "active_run_watchdog",
    ownerType: "board" as const,
    returnOwnerAgentId: input.agentId,
    cause: "legacy_execution_requires_reconciliation",
    status: input.status,
    resolvedAt: input.status === "resolved" ? new Date() : null,
    releasedAt: input.releasedAt ?? null,
    outcome: input.status === "resolved" ? "blocked" : null,
    evidence: input.evidence ?? {
      runId: input.runId,
      automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", actionOutcome: "unknown" },
    },
    fingerprint: `legacy-execution:${input.runId}`,
    nextAction: input.nextAction ?? "Inspect the stopped provider and recorded actions.",
  };
}


(support.supported ? describe : describe.skip)("settled no-replay holds are released", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      db = createDb(externalDatabaseUrl);
      return;
    }
    database = await startEmbeddedPostgresTestDatabase("paperclip-released-hold-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE companies CASCADE`);
  });

  afterAll(async () => {
    if (externalDatabaseUrl) await db?.$client.end();
    else await database?.cleanup();
  });

  it("stops holding the issue once the automatic sweep records the disposition", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const previousRunId = randomUUID();
    const issueId = await seedIssue({ db, companyId, agentId, status: "in_progress", previousRunId });
    const [action] = await db.insert(issueRecoveryActions)
      .values(interruptionHold({ companyId, issueId, agentId, runId: previousRunId, status: "active" }))
      .returning();

    // A live hold still holds: this is the invariant the release must not touch.
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: action!.id });

    await settleUnrecoverableExecutions(db);

    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    // The disposition and its evidence survive as a signal...
    expect(settled).toMatchObject({
      status: "resolved",
      outcome: "blocked",
      evidence: { automaticRecovery: { replay: "blocked" } },
    });
    // ...but the slot is gone, so the card accepts work again.
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
    expect(settled!.releasedAt).toBeInstanceOf(Date);
  });

  it("lets a queued wake run instead of cancelling it as a stale no-replay hold", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const previousRunId = randomUUID(), queuedRunId = randomUUID();
    const issueId = await seedIssue({ db, companyId, agentId, status: "blocked", previousRunId });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId, companyId, agentId, status: "queued", contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(issueRecoveryActions).values(interruptionHold({ companyId, issueId, agentId, runId: previousRunId, status: "active" }));
    await settleUnrecoverableExecutions(db);

    const adapter = createPostgresRunDispatchAdapter(db);
    expect(await adapter.cancelStaleQueuedRun({ companyId, runId: queuedRunId, expectedStatus: "queued", now: new Date() }))
      .toMatchObject({ outcome: "not_stale" });
    expect((await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId)))[0].status)
      .toBe("queued");
  });

  it("keeps holding a settled row that was never released", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const previousRunId = randomUUID();
    const issueId = await seedIssue({ db, companyId, agentId, status: "blocked", previousRunId });
    const [action] = await db.insert(issueRecoveryActions)
      .values(interruptionHold({ companyId, issueId, agentId, runId: previousRunId, status: "resolved" }))
      .returning();

    // released_at is the gate, not status: a resolved row without the marker is
    // still the effective no-replay hold the predicate promises.
    expect(action!.releasedAt).toBeNull();
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: action!.id });
  });

  it("keeps holding an unsafe workspace restore after the sweep records it", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const previousRunId = randomUUID();
    const issueId = await seedIssue({ db, companyId, agentId, status: "in_progress", previousRunId });
    await db.update(heartbeatRuns).set({
      runtimeMode: "legacy",
      errorCode: "workspace_restore_failed",
      resultJson: { workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1" },
    }).where(eq(heartbeatRuns.id, previousRunId));
    const [action] = await db.insert(issueRecoveryActions).values(interruptionHold({
      companyId, issueId, agentId, runId: previousRunId, status: "active",
      evidence: {
        runId: previousRunId,
        workspaceRestoreFailure: "restore_unsafe_archive",
        adapterRecovery: "unsupported_or_unknown",
      },
      nextAction: "Verify safe workspace staging or repair.",
    })).returning();

    await settleUnrecoverableExecutions(db);

    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    // No provider turn can repair an unsafe workspace, so this one disposition
    // deliberately keeps its hold until repair or reconciliation clears it.
    expect(settled!.releasedAt).toBeNull();
    expect(settled).toMatchObject({ status: "resolved", outcome: "blocked", evidence: { workspaceRestoreFailure: "restore_unsafe_archive" } });
    expect(await getExecutionBlocker(db, companyId, issueId)).toMatchObject({ recoveryActionId: action!.id });
  });
});
