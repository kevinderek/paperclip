import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issueThreadInteractions, issues } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { legacyDispositionEpisode } from "../services/recovery/legacy-continuation.js";
import { recoveryService } from "../services/recovery/service.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("legacy continuation persisted authority", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("legacy-authority-"); db = createDb(temporary.connectionString); }, 20_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function fixture(context: Record<string, unknown> = {}, continuationAttempt = 0) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Authority fixture", issuePrefix: `A${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Implement export", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "fixture-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded", runtimeMode: "legacy", continuationAttempt, contextSnapshot: { issueId, ...context }, livenessState: "blocked", resultJson: { summary: "All done. Need approval. I will continue." } });
    const createRecovery = (afterEnqueue?: (run: typeof heartbeatRuns.$inferSelect) => Promise<void>) => recoveryService(db, {
      enqueueWakeup: async (targetAgentId, opts) => db.transaction(async tx => {
        const [wake] = await tx.insert(agentWakeupRequests).values({ companyId, agentId: targetAgentId, source: "automation", reason: opts?.reason, payload: opts?.payload, idempotencyKey: opts?.idempotencyKey, status: "queued" }).returning();
        const [run] = await tx.insert(heartbeatRuns).values({ companyId, agentId: targetAgentId, invocationSource: "automation", status: "queued", runtimeMode: "legacy", wakeupRequestId: wake.id, contextSnapshot: opts?.contextSnapshot }).returning();
        await tx.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
        return run;
      }).then(async run => { await afterEnqueue?.(run); return run; }),
    });
    const runs = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const actions = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId));
    async function finish(run: typeof heartbeatRuns.$inferSelect) {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
      if (run.wakeupRequestId) await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, run.wakeupRequestId));
    }
    return { companyId, agentId, issueId, runId, createRecovery, runs, actions, finish };
  }
  it.each([1, 2, 3, 4, 5])("deduplicates concurrent replay with stale prose-derived liveness (%s)", async () => {
    const f = await fixture();
    const recovery = f.createRecovery();
    await Promise.all([recovery.reconcileLegacyContinuation(f.runId), recovery.reconcileLegacyContinuation(f.runId)]);
    expect(await f.runs()).toHaveLength(2);
    expect(await f.actions()).toHaveLength(1);
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    expect(await f.runs()).toHaveLength(2);
    const repair = (await f.runs()).find(r => r.id !== f.runId)!;
    expect(repair.contextSnapshot).toMatchObject({ legacyDispositionEpisode: { id: f.runId, attempt: 1, maxAttempts: 2 } });
  });
  it("does not roll back the ledger when a fast repair finishes before enqueue returns", async () => {
    const f = await fixture();
    await f.createRecovery(async first => {
      await f.finish(first);
      await f.createRecovery().reconcileLegacyContinuation(first.id);
      expect((await f.actions())[0].attemptCount).toBe(2);
    }).reconcileLegacyContinuation(f.runId);
    const second = (await f.runs()).find(r => r.status === "scheduled_retry")!;
    expect((await f.actions())[0]).toMatchObject({ attemptCount: 2, wakePolicy: { scheduledRunId: second.id, attempt: 2 } });
    expect(await f.runs()).toHaveLength(3);
  });
  it("keeps the same bounded episode across restart and commentary, then escalates only after agent attempts", async () => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    await f.finish(first);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, body: "I will continue; all done; no approval required." });
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    const second = (await f.runs()).find(r => r.status === "scheduled_retry")!;
    expect(second.contextSnapshot).toMatchObject({ legacyDispositionEpisode: { id: f.runId, attempt: 2, maxAttempts: 2 } });
    await f.finish(second);
    expect(await f.createRecovery().reconcileLegacyContinuation(second.id)).toBe("escalated");
    expect(await f.runs()).toHaveLength(3);
    expect((await f.actions()).find(a => a.status === "active")).toMatchObject({ ownerType: "board", attemptCount: 2 });
    await f.createRecovery().reconcileLegacyContinuation(second.id);
    expect(await f.runs()).toHaveLength(3);
  });
  it.each(["silent", "comments", "tool-calls"])("ACCT-02 full recovery sweep cannot replenish an exhausted episode with %s", async noise => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    await f.finish(first);
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    const second = (await f.runs()).find(r => r.status === "scheduled_retry")!;
    await f.finish(second);
    if (noise === "comments") await db.insert(issueComments).values(Array.from({ length: 20 }, () => ({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, createdByRunId: second.id, body: "All done. No approval needed. Real progress! Continue." })));
    await db.update(heartbeatRuns).set({ livenessState: "advanced", resultJson: { summary: "Continuing", toolCallCount: noise === "tool-calls" ? 1000 : 0 } }).where(eq(heartbeatRuns.id, second.id));
    // Enter through the sweep while the task is still in_progress, so the
    // old comment/attachment progress exemption cannot bypass exhaustion.
    await f.createRecovery().reconcileStrandedAssignedIssues();
    expect(await f.runs()).toHaveLength(3);
    expect((await f.actions()).find(a => a.status === "active")).toMatchObject({ ownerType: "board", attemptCount: 2 });
  });

  it.each(["approval", "budget", "pause", "reassigned"])("ACCT-03 %s introduced during second repair delay survives restart without another debit", async gate => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    await f.finish(first);
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    const second = (await f.runs()).find(r => r.status === "scheduled_retry")!;
    expect(await f.createRecovery().legacyRepairDispatchBlock(second.id)).toBeNull();
    if (gate === "approval") await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Continue?" } });
    if (gate === "budget") await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, f.companyId));
    if (gate === "pause") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    expect(await f.createRecovery().legacyRepairDispatchBlock(second.id)).not.toBeNull();
    expect((await heartbeatService(db).promoteDueScheduledRetries(new Date(second.scheduledRetryAt!.getTime() + 1))).runIds).not.toContain(second.id);
    expect((await f.runs()).find(r => r.id === second.id)?.status).toBe("cancelled");
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    expect(await f.runs()).toHaveLength(3);
    expect((await f.actions())[0].attemptCount).toBe(2);
  });

  it("ACCT-04 a delayed second repair remains promotable after controller restart", async () => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    await f.finish(first);
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    const second = (await f.runs()).find(r => r.status === "scheduled_retry")!;
    expect(await f.createRecovery().legacyRepairDispatchBlock(second.id)).toBeNull();
    const restarted = heartbeatService(db);
    const promoted = await restarted.promoteDueScheduledRetries(new Date(second.scheduledRetryAt!.getTime() + 1));
    expect.soft(promoted.runIds).toContain(second.id);
    expect((await f.runs()).find(r => r.id === second.id)).toMatchObject({ status: "queued", errorCode: null });
    expect((await f.actions())[0].attemptCount).toBe(2);
  });

  it("ACCT-01 repairs preserve prior infrastructure and productive debits", async () => {
    const f = await fixture();
    const accounting = { version: 1, failureRetries: 2, maxTurnContinuations: 1 };
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionRetryAccounting: accounting } }).where(eq(heartbeatRuns.id, f.runId));
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    expect(first.contextSnapshot?.executionRetryAccounting).toEqual(accounting);
    await f.finish(first);
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    expect((await f.runs()).find(r => r.status === "scheduled_retry")?.contextSnapshot?.executionRetryAccounting).toEqual(accounting);
  });

  it.each(["foreign-source", "changed-episode", "exhausted-slot"])("ACCT-04 rejects a delayed repair with %s", async mutation => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    await f.finish(first);
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    const second = (await f.runs()).find(r => r.status === "scheduled_retry")!;
    const context = structuredClone(second.contextSnapshot!) as Record<string, any>;
    if (mutation === "foreign-source") {
      const foreign = await fixture();
      context.dispositionRepairSourceRunId = foreign.runId;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, foreign.issueId));
    }
    if (mutation === "changed-episode") context.legacyDispositionEpisode.id = randomUUID();
    if (mutation === "exhausted-slot") context.legacyDispositionEpisode.attempt = 3;
    await db.update(heartbeatRuns).set({ contextSnapshot: context }).where(eq(heartbeatRuns.id, second.id));
    expect((await heartbeatService(db).promoteDueScheduledRetries(new Date(second.scheduledRetryAt!.getTime() + 1))).runIds).not.toContain(second.id);
    expect((await f.runs()).find(r => r.id === second.id)).toMatchObject({ status: "cancelled", errorCode: "issue_disposition_repair_superseded" });
  });

  it("persists the source identity while the second repair waits to dispatch", async () => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    await db.update(heartbeatRuns).set({ responsibleUserId: "initiating-operator" }).where(eq(heartbeatRuns.id, first.id));
    await f.finish(first);
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    expect((await f.runs()).find(r => r.status === "scheduled_retry")?.responsibleUserId).toBe("initiating-operator");
  });
  it.each(["retry_queued", "retry_exhausted"])("does not stack a new repair budget on the %s comment policy", async issueCommentStatus => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ issueCommentStatus }).where(eq(heartbeatRuns.id, f.runId));
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.runs()).toHaveLength(1);
  });
  it("does not grant a new budget to exhausted pre-upgrade continuation", async () => {
    const f = await fixture({}, 2);
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("escalated");
    expect(await f.runs()).toHaveLength(1);
  });

  // A comment that reopens a stranded issue mints a fresh legacy episode, so an
  // episode-anchored budget can never run out. These three tests pin the durable
  // source state as the anchor instead: a reopen that changes nothing is refused
  // a fresh budget, a durable change still earns one, and an explicit board
  // settle still opens the handle.
  async function exhaustedAfterReopen() {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const first = (await f.runs()).find(r => r.id !== f.runId)!;
    await f.finish(first);
    await f.createRecovery().reconcileLegacyContinuation(first.id);
    const second = (await f.runs()).find(r => r.status === "scheduled_retry")!;
    await f.finish(second);
    expect(await f.createRecovery().reconcileLegacyContinuation(second.id)).toBe("escalated");
    const escalated = (await f.actions()).find(a => a.status === "active")!;
    const sourceStateFingerprint = escalated.evidence.sourceStateFingerprint as string;
    expect(sourceStateFingerprint).toMatch(/^disposition_repair:v1:/);
    // Reproduce the reopen exactly as the comment route leaves it: the issue
    // returns to todo, the standing escalation is cancelled as stale
    // (source_revalidation), and the wake runs as a brand new episode.
    await db.update(issueRecoveryActions)
      .set({ status: "cancelled", outcome: "cancelled", resolutionNote: "source_revalidation", resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(issueRecoveryActions.id, escalated.id));
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
    await db.insert(issueComments).values({
      companyId: f.companyId,
      issueId: f.issueId,
      authorType: "user",
      authorUserId: "fixture-owner",
      body: "Board handed this back, please try again.",
    });
    const [reopened] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId,
      agentId: f.agentId,
      invocationSource: "automation",
      status: "succeeded",
      runtimeMode: "legacy",
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "issue_reopened_via_comment" },
      livenessState: "blocked",
      resultJson: { summary: "Taking another look at this." },
    }).returning();
    // The reopened wake puts the issue back in_progress, which is the status it
    // also had when the exhausted escalation ran. Status is part of the digested
    // source state, so this is what makes the digest comparable across the reopen.
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.issueId));
    // The loop precondition: a fresh episode id over an unchanged source state.
    expect(legacyDispositionEpisode(second).id).not.toBe(legacyDispositionEpisode(reopened).id);
    return { f, reopened, sourceStateFingerprint, runsBefore: (await f.runs()).length };
  }

  it("refuses a reopened issue a fresh budget while its durable source state is unchanged", async () => {
    const { f, reopened, sourceStateFingerprint, runsBefore } = await exhaustedAfterReopen();
    expect(await f.createRecovery().reconcileLegacyContinuation(reopened.id)).toBe("escalated");
    // No successor agent run: the loop is closed instead of restarted.
    expect(await f.runs()).toHaveLength(runsBefore);
    const standing = (await f.actions()).find(a => a.status === "active")!;
    expect(standing.evidence).toMatchObject({
      terminalReason: "unchanged_source_state_exhausted",
      sourceStateFingerprint,
    });
    expect(standing.ownerType).toBe("board");
  });

  it("grants a reopened issue a fresh budget after one durable source-state change", async () => {
    const { f, reopened, sourceStateFingerprint } = await exhaustedAfterReopen();
    // executionPolicy is one of the digested durable fields, so this is the
    // positive half: the same reopen now earns a complete new budget.
    await db.update(issues).set({ executionPolicy: { mode: "auto" } }).where(eq(issues.id, f.issueId));
    expect(await f.createRecovery().reconcileLegacyContinuation(reopened.id)).toBe("queued");
    const repair = (await f.runs()).find(r => (r.contextSnapshot as Record<string, any> | null)?.legacyDispositionEpisode)!;
    expect(repair).toBeTruthy();
    expect(repair.contextSnapshot).toMatchObject({ legacyDispositionEpisode: { id: reopened.id, attempt: 1, maxAttempts: 2 } });
    const queued = (await f.actions()).find(a => a.status === "active")!;
    expect(queued.evidence.sourceStateFingerprint).not.toBe(sourceStateFingerprint);
    expect(queued.attemptCount).toBe(1);
  });

  it("lets an explicit board settle clear a spent budget that a comment cannot", async () => {
    const { f, reopened } = await exhaustedAfterReopen();
    await db.update(issueRecoveryActions)
      .set({ status: "resolved", outcome: "handed_back", resolutionNote: "Retrying the recorded owner.", resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(issueRecoveryActions.companyId, f.companyId), eq(issueRecoveryActions.sourceIssueId, f.issueId)));
    expect(await f.createRecovery().reconcileLegacyContinuation(reopened.id)).toBe("queued");
    const repair = (await f.runs()).find(r => (r.contextSnapshot as Record<string, any> | null)?.legacyDispositionEpisode)!;
    expect(repair.contextSnapshot).toMatchObject({ legacyDispositionEpisode: { id: reopened.id, attempt: 1, maxAttempts: 2 } });
  });
  it.each(["done", "cancelled", "blocked", "in_review"])("honors durable %s instead of the final summary", async status => {
    const f = await fixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.runs()).toHaveLength(1);
  });
  it("respects a pending approval while the issue still says in progress", async () => {
    const f = await fixture();
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone", payload: { version: 1, prompt: "Approve?" } });
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.runs()).toHaveLength(1);
  });
  it("rechecks a newly pending approval at dispatch without spending another attempt", async () => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const repair = (await f.runs()).find(r => r.id !== f.runId)!;
    expect(await f.createRecovery().legacyRepairDispatchBlock(repair.id)).toBeNull();
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending", requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone", payload: { version: 1, prompt: "Approve?" } });
    expect(await f.createRecovery().legacyRepairDispatchBlock(repair.id)).toBe("durable_wait");
    expect((await f.actions())[0].attemptCount).toBe(1);
  });
  it("preserves repair authority and its budget through a typed infrastructure retry", async () => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const repair = (await f.runs()).find(r => r.id !== f.runId)!;
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "transient_failure" }).where(eq(heartbeatRuns.id, repair.id));
    await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, repair.wakeupRequestId!));
    const [retry] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "queued", runtimeMode: "legacy", retryOfRunId: repair.id,
      contextSnapshot: { ...repair.contextSnapshot, retryOfRunId: repair.id, retryReason: "transient_failure", wakeReason: "transient_failure_retry" },
    }).returning();
    expect(await f.createRecovery().legacyRepairDispatchBlock(retry.id)).toBeNull();
    expect((await f.actions())[0].attemptCount).toBe(1);
    await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId, kind: "request_confirmation", status: "pending", payload: { version: 1, prompt: "Approve?" } });
    expect(await f.createRecovery().legacyRepairDispatchBlock(retry.id)).toBe("durable_wait");
  });
  it.each(["done", "paused", "reassigned", "stopped"])("suppresses a queued repair after %s", async gate => {
    const f = await fixture();
    await f.createRecovery().reconcileLegacyContinuation(f.runId);
    const repair = (await f.runs()).find(r => r.id !== f.runId)!;
    if (gate === "done") await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    if (gate === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    if (gate === "stopped") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "operator_cancelled" }).where(eq(heartbeatRuns.id, repair.id));
    expect(await f.createRecovery().legacyRepairDispatchBlock(repair.id)).not.toBeNull();
    expect((await f.actions())[0].attemptCount).toBe(1);
  });
  it.each([{ goalControlRequestId: "control" }, { resumeSessionGoalHeartbeat: true }])("leaves goal-control run ownership intact: %j", async context => {
    const f = await fixture(context);
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.actions()).toHaveLength(0);
    expect(await f.runs()).toHaveLength(1);
  });
  it("leaves a due monitor as the owner of the next step", async () => {
    const f = await fixture();
    await db.update(issues).set({ monitorNextCheckAt: new Date(0) }).where(eq(issues.id, f.issueId));
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.runs()).toHaveLength(1);
  });
  it("honors pause and changed ownership without spending a repair attempt", async () => {
    const f = await fixture();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.actions()).toHaveLength(0);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    expect(await f.createRecovery().reconcileLegacyContinuation(f.runId)).toBe("skipped");
    expect(await f.runs()).toHaveLength(1);
  });
  it("the delayed sweep ignores old diagnostic labels and uses the same repair path", async () => {
    const f = await fixture();
    await f.createRecovery().reconcileStrandedAssignedIssues({ companyId: f.companyId });
    expect(await f.runs()).toHaveLength(2);
    const repair = (await f.runs()).find(r => r.id !== f.runId)!;
    expect(repair.contextSnapshot).toMatchObject({ legacyDispositionEpisode: { id: f.runId, attempt: 1 } });
  });
});
