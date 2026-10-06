import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { listStrandedDeferredWakes } from "../services/stranded-deferred-wakes.js";
import { STRANDED_WAKE_STALE_AFTER_MS } from "../modules/wake-queue/domain/policy.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping stranded deferred wake tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type CompanyRow = typeof companies.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type IssueRow = typeof issues.$inferSelect;
type WakeRow = typeof agentWakeupRequests.$inferSelect;

async function seedCompany(db: Db, label: string) {
  const nonce = randomUUID().slice(0, 8);
  const [company] = await db.insert(companies).values({
    name: `${label} ${nonce}`,
    issuePrefix: `SD${nonce.slice(0, 4).toUpperCase()}`,
    defaultResponsibleUserId: "board-user",
  }).returning();
  return company!;
}

async function seedAgent(db: Db, companyId: string) {
  const [agent] = await db.insert(agents).values({
    companyId,
    name: `Agent ${randomUUID().slice(0, 6)}`,
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
  }).returning();
  return agent!;
}

async function seedIssue(
  db: Db,
  input: { companyId: string; assigneeAgentId: string | null; status?: string },
) {
  const [issue] = await db.insert(issues).values({
    companyId: input.companyId,
    projectId: null,
    parentId: null,
    title: `Stranded wake target ${randomUUID().slice(0, 6)}`,
    status: input.status ?? "todo",
    priority: "high",
    assigneeAgentId: input.assigneeAgentId,
    responsibleUserId: "board-user",
  }).returning();
  return issue!;
}

/**
 * The exact row shape measured on 2026-10-06 for REK-587: a deferred comment
 * wake on a `todo` issue whose owner released the lock, carrying the queued
 * comment ids under `_paperclipWakeContext`.
 */
async function seedStrandedDeferredWake(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    issueId: string;
    ageMs: number;
    commentIds?: string[];
  },
): Promise<WakeRow> {
  const commentIds = input.commentIds ?? [randomUUID()];
  const requestedAt = new Date(Date.now() - input.ageMs);
  const [wake] = await db.insert(agentWakeupRequests).values({
    companyId: input.companyId,
    agentId: input.agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    status: "deferred_issue_execution",
    requestedAt,
    updatedAt: requestedAt,
    payload: {
      issueId: input.issueId,
      _paperclipWakeContext: { wakeCommentIds: commentIds },
    },
  }).returning();
  return wake!;
}

describeEmbeddedPostgres("stranded deferred wakes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-deferred-wake-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The measured defect: a card that waited 1.3 days behind a wake no run owns
  // looked identical to a card nobody had touched yet. AC2 asks for it to be
  // visible in a view an agent reads routinely.
  it("reports the oldest stranded wake per issue once it passed the waiting bound", async () => {
    const company = await seedCompany(db, "Stranded Visible");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, { companyId: company.id, assigneeAgentId: agent.id });
    const wake = await seedStrandedDeferredWake(db, {
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      ageMs: STRANDED_WAKE_STALE_AFTER_MS + 60_000,
      commentIds: ["comment-a", "comment-b"],
    });

    const projected = await listStrandedDeferredWakes(db, {
      companyId: company.id,
      agentId: agent.id,
      olderThanMs: STRANDED_WAKE_STALE_AFTER_MS,
    });

    const entry = projected.get(issue.id);
    expect(entry).toMatchObject({
      wakeupRequestId: wake.id,
      reason: "issue_commented",
      queuedCommentCount: 2,
    });
    expect(entry!.waitingMs).toBeGreaterThanOrEqual(STRANDED_WAKE_STALE_AFTER_MS);
  });

  // AC3, negative control: a wake that is still young is not stranded work
  // yet, so it must not raise an alarm the inbox cannot act on.
  it("does not report a wake that is still inside the waiting bound", async () => {
    const company = await seedCompany(db, "Stranded Young");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, { companyId: company.id, assigneeAgentId: agent.id });
    await seedStrandedDeferredWake(db, {
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      ageMs: 60_000,
    });

    const projected = await listStrandedDeferredWakes(db, {
      companyId: company.id,
      agentId: agent.id,
      olderThanMs: STRANDED_WAKE_STALE_AFTER_MS,
    });

    expect(projected.has(issue.id)).toBe(false);
  });

  // A wake whose issue is still executing has an owner. Reporting it would
  // name ordinary queueing as a fault.
  it("does not report a wake whose issue still holds an execution run", async () => {
    const company = await seedCompany(db, "Stranded Owned");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, { companyId: company.id, assigneeAgentId: agent.id, status: "in_progress" });
    await seedStrandedDeferredWake(db, {
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      ageMs: STRANDED_WAKE_STALE_AFTER_MS * 3,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "running",
      contextSnapshot: { issueId: issue.id, taskId: issue.id },
    }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issue.id));

    const projected = await listStrandedDeferredWakes(db, {
      companyId: company.id,
      agentId: agent.id,
      olderThanMs: STRANDED_WAKE_STALE_AFTER_MS,
    });

    expect(projected.has(issue.id)).toBe(false);
  });

  // The negative class that makes the positive one meaningful: a card with no
  // stranded wake reports nothing at all.
  it("reports nothing for a card with no stranded wake", async () => {
    const company = await seedCompany(db, "Stranded Absent");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, { companyId: company.id, assigneeAgentId: agent.id });

    const projected = await listStrandedDeferredWakes(db, {
      companyId: company.id,
      agentId: agent.id,
      olderThanMs: STRANDED_WAKE_STALE_AFTER_MS,
    });

    expect(projected.has(issue.id)).toBe(false);
  });

  // Only the oldest wake per issue is projected: two stranded rows on one card
  // describe one wait, and reporting both would double-count it.
  it("reports the oldest stranded wake when a card has several", async () => {
    const company = await seedCompany(db, "Stranded Multiple");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, { companyId: company.id, assigneeAgentId: agent.id });
    const oldest = await seedStrandedDeferredWake(db, {
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      ageMs: STRANDED_WAKE_STALE_AFTER_MS * 4,
    });
    await seedStrandedDeferredWake(db, {
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      ageMs: STRANDED_WAKE_STALE_AFTER_MS * 2,
    });

    const projected = await listStrandedDeferredWakes(db, {
      companyId: company.id,
      agentId: agent.id,
      olderThanMs: STRANDED_WAKE_STALE_AFTER_MS,
    });

    expect(projected.get(issue.id)?.wakeupRequestId).toBe(oldest.id);
  });

  // An empty inbox must not issue a query that joins every wake of the company.
  it("returns an empty map without querying when no issue ids are given", async () => {
    const company = await seedCompany(db, "Stranded Empty Inbox");
    const agent = await seedAgent(db, company.id);

    const projected = await listStrandedDeferredWakes(db, {
      companyId: company.id,
      agentId: agent.id,
      issueIds: [],
      olderThanMs: STRANDED_WAKE_STALE_AFTER_MS,
    });

    expect(projected.size).toBe(0);
  });

  // The projection is read-only. A reader that writes would race the sweep
  // that owns the repair, and would move a row off the status the sweep
  // selects on without ever retiring it properly.
  it("leaves the wake row exactly as it found it", async () => {
    const company = await seedCompany(db, "Stranded Read Only");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, { companyId: company.id, assigneeAgentId: agent.id });
    const wake = await seedStrandedDeferredWake(db, {
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      ageMs: STRANDED_WAKE_STALE_AFTER_MS * 2,
    });

    await listStrandedDeferredWakes(db, {
      companyId: company.id,
      agentId: agent.id,
      olderThanMs: STRANDED_WAKE_STALE_AFTER_MS,
    });

    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(after).toMatchObject({
      status: "deferred_issue_execution",
      runId: null,
      finishedAt: null,
      error: null,
    });
    expect(after!.updatedAt.getTime()).toBe(wake.updatedAt.getTime());
  });

  // AC3, the other half: nothing on the read path may reset a card that is
  // waiting on a wake. The projection must leave `status` and every blocker
  // field untouched, so a stranded card is never quietly made healthy again.
  it("does not reset a waiting card to todo or clear its blockers", async () => {
    const company = await seedCompany(db, "Stranded No Reset");
    const agent = await seedAgent(db, company.id);
    const issue = await seedIssue(db, { companyId: company.id, assigneeAgentId: agent.id, status: "blocked" });
    await db.update(issues).set({ monitorNextCheckAt: null }).where(eq(issues.id, issue.id));
    await seedStrandedDeferredWake(db, {
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      ageMs: STRANDED_WAKE_STALE_AFTER_MS * 2,
    });

    await listStrandedDeferredWakes(db, {
      companyId: company.id,
      agentId: agent.id,
      olderThanMs: STRANDED_WAKE_STALE_AFTER_MS,
    });

    const [after] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(after).toMatchObject({
      status: "blocked",
      executionRunId: null,
      monitorNextCheckAt: null,
    });

    const activity = await db.select().from(activityLog).where(and(eq(activityLog.entityId, issue.id)));
    expect(activity).toHaveLength(0);
  });
});