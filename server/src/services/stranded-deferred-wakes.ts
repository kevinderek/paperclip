import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { agentWakeupRequests, issues, type Db } from "@paperclipai/db";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import type { StrandedDeferredWakeProjection } from "../modules/wake-queue/domain/policy.js";

/**
 * The same predicate `resumeQueuedRuns` uses to find deferred wakes whose
 * owning run already released the issue: the row is still
 * `deferred_issue_execution`, the issue holds no execution run, and the issue
 * is still assigned to the wake's agent. One definition, so the sweep and
 * every reader can never disagree about which rows are stranded.
 */
function strandedDeferredWakePredicate(agentId: string, issueIds?: string[]) {
  return and(
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    isNull(issues.executionRunId),
    issueIds?.length ? inArray(issues.id, issueIds) : undefined,
    sql`${issues.assigneeAgentId} = ${agentId}`,
    or(
      and(
        sql`jsonb_typeof(${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}') = 'array'`,
        sql`${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}' <> '[]'::jsonb`,
      ),
      sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`,
    ),
  );
}

/**
 * Reads the oldest stranded deferred wake per issue for one agent.
 *
 * Measured on 2026-10-06 (REK-608): a wake whose owning run released the
 * issue through the reconciliation branch of the pre-drain decision was never
 * re-examined, so it stayed `deferred_issue_execution` for 1.3 days while the
 * issue itself looked ordinary in every list. This read makes that state
 * visible without touching the row, which is the sweep's job.
 */
export async function listStrandedDeferredWakes(
  db: Db,
  input: { companyId: string; agentId: string; issueIds?: string[]; olderThanMs: number; limit?: number },
): Promise<Map<string, StrandedDeferredWakeProjection>> {
  if (input.issueIds && input.issueIds.length === 0) return new Map();
  const cutoff = new Date(Date.now() - input.olderThanMs);
  const rows = await db
    .select({
      wakeupRequestId: agentWakeupRequests.id,
      reason: agentWakeupRequests.reason,
      requestedAt: agentWakeupRequests.requestedAt,
      payload: agentWakeupRequests.payload,
      issueId: issues.id,
    })
    .from(agentWakeupRequests)
    .innerJoin(
      issues,
      and(
        eq(issues.companyId, agentWakeupRequests.companyId),
        sql`${issues.id}::text = ${agentWakeupRequests.payload}->>'issueId'`,
      ),
    )
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      strandedDeferredWakePredicate(input.agentId, input.issueIds),
      lt(agentWakeupRequests.requestedAt, cutoff),
    ))
    .orderBy(asc(agentWakeupRequests.requestedAt))
    .limit(input.limit ?? 500);

  const oldestPerIssue = new Map<string, StrandedDeferredWakeProjection>();
  for (const row of rows) {
    // The oldest stranded wake is the one that describes how long the card has
    // been waiting; a later row for the same issue adds nothing an agent can act on.
    if (oldestPerIssue.has(row.issueId)) continue;
    oldestPerIssue.set(row.issueId, {
      wakeupRequestId: row.wakeupRequestId,
      reason: row.reason,
      requestedAt: row.requestedAt.toISOString(),
      waitingMs: Date.now() - row.requestedAt.getTime(),
      queuedCommentCount: queuedCommentIdsFromWakePayload(row.payload).length,
    });
  }
  return oldestPerIssue;
}