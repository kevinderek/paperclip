import { createHash } from "node:crypto";
import { and, eq, inArray, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueRelations,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS } from "./legacy-continuation.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

export const DISPOSITION_REPAIR_MAX_ATTEMPTS = 5;
export const DISPOSITION_REPAIR_BASE_DELAYS_MS = [0, 60_000, 120_000, 240_000, 480_000] as const;

type DispositionRepairIssue = Pick<
  typeof issues.$inferSelect,
  | "id"
  | "companyId"
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "executionPolicy"
  | "executionState"
  | "monitorNextCheckAt"
>;

export type DispositionRepairSourceState = {
  fingerprint: string;
  dependencyIssueIds: string[];
  hasActiveExecutionPath: boolean;
  hasDurableWaitingPath: boolean;
  durablePathReason: string | null;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function boundedRecoveryDelayMs(
  attempt: number,
  fingerprint: string,
  delays: readonly number[],
  lane: string,
) {
  const baseDelayMs = delays[attempt - 1];
  if (baseDelayMs === undefined) throw new Error(`Invalid ${lane} attempt: ${attempt}`);
  if (baseDelayMs === 0) return { baseDelayMs, jitterMs: 0, delayMs: 0 };

  const jitterBoundMs = Math.floor(baseDelayMs * 0.1);
  const sample = Number.parseInt(
    createHash("sha256").update(`${fingerprint}:${attempt}`).digest("hex").slice(0, 8),
    16,
  );
  const jitterMs = sample % (jitterBoundMs + 1);
  return { baseDelayMs, jitterMs, delayMs: baseDelayMs + jitterMs };
}

export function dispositionRepairDelayMs(attempt: number, fingerprint: string) {
  return boundedRecoveryDelayMs(
    attempt,
    fingerprint,
    DISPOSITION_REPAIR_BASE_DELAYS_MS,
    "disposition repair",
  );
}

function boundedCeiling(value: unknown, fallback: number) {
  const parsed = typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : fallback;
  return Math.max(1, parsed);
}

/**
 * The ceiling a disposition-repair episode is measured against.
 *
 * The legacy spine of {@link LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS} exists for
 * a run that ended without a recorded disposition *and* without doing work: a
 * continuation park. A run that succeeded and recorded no error code did its
 * work — it just failed to write the disposition. Comments are not part of the
 * durable source state, so no later sweep can tell the two apart, and the short
 * ceiling escalated the board roughly a second after the assignee's own closing
 * comment. Spend the regular owner-sticky spine for a succeeded run instead.
 *
 * The legacy episode keeps owning the attempt accounting and the episode
 * fingerprint; only the number it is compared against widens.
 */
export function dispositionRepairMaxAttemptsForRun(input: {
  legacyMaxAttempts?: number | null;
  runSucceeded: boolean;
}) {
  if (!input.runSucceeded) {
    return boundedCeiling(
      input.legacyMaxAttempts,
      LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS,
    );
  }
  return DISPOSITION_REPAIR_MAX_ATTEMPTS;
}

/**
 * Whether an escalation would repeat a notice the board already received.
 *
 * Identity of a disposition-repair episode is its durable source state, not its
 * per-run episode fingerprint: the episode id is minted per repair attempt, so
 * a second sweep over an unchanged source state produced a second, identical
 * "Agent needs attention" comment and a second identical recovery action. One
 * standing board escalation per (issue, source state, terminal reason) is the
 * whole point — the board keeps exactly one decision to make.
 *
 * A resolved or retried action is no longer active, so the next sweep mints a
 * fresh recovery identity and the board is told again. That is deliberate: the
 * resolve was a decision, and a decision deserves a fresh notice.
 */
export function dispositionRepairEscalationRepeatsStandingNotice(input: {
  activeKind?: string | null;
  activeOwnerType?: string | null;
  activeEvidence?: unknown;
  issueStatus?: string | null;
  sourceStateFingerprint: string;
  terminalReason: string;
}) {
  if (input.activeKind !== "deliberate_wait_without_target") return false;
  if (input.activeOwnerType !== "board") return false;
  // A source issue that is not blocked did not absorb the earlier escalation, so
  // re-running the full escalation is what puts it back in front of the board.
  if (input.issueStatus !== "blocked") return false;
  const evidence = input.activeEvidence && typeof input.activeEvidence === "object"
    && !Array.isArray(input.activeEvidence)
    ? input.activeEvidence as Record<string, unknown>
    : {};
  if (evidence.sourceStateFingerprint !== input.sourceStateFingerprint) return false;
  return evidence.terminalReason === input.terminalReason;
}

/**
 * How long one issue stays quiet per terminal reason after the board was told.
 *
 * Same order of magnitude as the provider-quota backoff
 * (`PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS`, one hour): that lane already
 * treats an hour as the shortest honest interval before repeating itself to a
 * human.
 */
export const DISPOSITION_REPAIR_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * How many recovery-action records of one issue are inspected for an earlier
 * notice. Newest first, so a limit truncates the oldest history first.
 */
export const DISPOSITION_REPAIR_NOTICE_LOOKBACK = 50;

function readEvidenceRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readEvidenceTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Whether this escalation would repeat a board notice that is still fresh.
 *
 * {@link dispositionRepairEscalationRepeatsStandingNotice} only sees a *standing*
 * board escalation. Anything that takes the source issue off `blocked` clears
 * `active` on purpose — a handback, and above all the `source_revalidation`
 * cancel ("stale because the source issue was manually moved from blocked to
 * todo") — and the next sweep then starts a fresh episode with a fresh notice.
 * Measured 2026-10-04 over 12h: of 12 `issue.disposition_repair_escalated` rows
 * in a 3h13m window, 5 repeats followed exactly such a clear, the shortest 42 s
 * after the board itself moved the issue back to `todo`. Those repeats carry no
 * new information — the board just decided to retry the same failing agent — so
 * the escalation still happens (the issue is blocked, the action is board-owned
 * and resolvable) but the notice is withheld until the window elapses.
 *
 * Silence is bounded: after the cooldown the next escalation notifies again, and
 * a different terminal reason always notifies immediately.
 */
export function dispositionRepairEscalationRepeatsRecentNotice(input: {
  priorEvidences: readonly unknown[];
  terminalReason: string;
  now: Date;
  cooldownMs?: number;
}) {
  const cooldownMs = Math.max(
    0,
    input.cooldownMs ?? DISPOSITION_REPAIR_NOTICE_COOLDOWN_MS,
  );
  if (cooldownMs === 0) return false;
  const nowMs = input.now.getTime();
  return input.priorEvidences.some((candidate) => {
    const evidence = readEvidenceRecord(candidate);
    if (evidence.terminalReason !== input.terminalReason) return false;
    const escalatedAtMs = readEvidenceTimestampMs(evidence.escalatedAt);
    if (escalatedAtMs === null) return false;
    const ageMs = nowMs - escalatedAtMs;
    // A future timestamp is not evidence of a notice; ignore it rather than
    // suppressing forever.
    return ageMs >= 0 && ageMs < cooldownMs;
  });
}

export async function collectDispositionRepairSourceState(
  db: Db,
  input: {
    issue: DispositionRepairIssue;
    excludeRunId?: string | null;
    excludeWakeupRequestId?: string | null;
  },
): Promise<DispositionRepairSourceState> {
  const issue = input.issue;
  const [blockers, children, interactions, linkedApprovals, workProducts, activeRuns, queuedWakes] =
    await Promise.all([
      db
        .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issueRelations)
        .innerJoin(
          issues,
          and(eq(issues.companyId, issueRelations.companyId), eq(issues.id, issueRelations.issueId)),
        )
        .where(
          and(
            eq(issueRelations.companyId, issue.companyId),
            eq(issueRelations.relatedIssueId, issue.id),
            eq(issueRelations.type, "blocks"),
            notInArray(issues.status, ["done", "cancelled"]),
            sql`${issues.hiddenAt} is null`,
          ),
        ),
      db
        .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, issue.companyId),
            eq(issues.parentId, issue.id),
            notInArray(issues.status, ["done", "cancelled"]),
            sql`${issues.hiddenAt} is null`,
          ),
        ),
      db
        .select({
          id: issueThreadInteractions.id,
          status: issueThreadInteractions.status,
          kind: issueThreadInteractions.kind,
          continuationPolicy: issueThreadInteractions.continuationPolicy,
          updatedAt: issueThreadInteractions.updatedAt,
        })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, issue.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
            inArray(issueThreadInteractions.status, ["pending", "accepted", "answered"]),
          ),
        ),
      db
        .select({ id: approvals.id, status: approvals.status, decidedAt: approvals.decidedAt })
        .from(issueApprovals)
        .innerJoin(
          approvals,
          and(
            eq(issueApprovals.approvalId, approvals.id),
            eq(issueApprovals.companyId, approvals.companyId),
          ),
        )
        .where(
          and(
            eq(issueApprovals.companyId, issue.companyId),
            eq(approvals.companyId, issue.companyId),
            eq(issueApprovals.issueId, issue.id),
            inArray(approvals.status, ["pending", "revision_requested", "approved"]),
          ),
        ),
      db
        .select({
          id: issueWorkProducts.id,
          type: issueWorkProducts.type,
          status: issueWorkProducts.status,
          reviewState: issueWorkProducts.reviewState,
          updatedAt: issueWorkProducts.updatedAt,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, issue.companyId),
            eq(issueWorkProducts.issueId, issue.id),
          ),
        ),
      db
        .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, issue.companyId),
            inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
            input.excludeRunId ? ne(heartbeatRuns.id, input.excludeRunId) : sql`true`,
          ),
        ),
      db
        .select({ id: agentWakeupRequests.id, agentId: agentWakeupRequests.agentId, status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, issue.companyId),
            inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.id}`,
            input.excludeWakeupRequestId
              ? ne(agentWakeupRequests.id, input.excludeWakeupRequestId)
              : sql`true`,
          ),
        ),
    ]);

  const pendingExecutionState = parseIssueExecutionState(issue.executionState);
  const pendingInteraction = interactions.some((row) => row.status === "pending");
  const pendingApproval = linkedApprovals.some((row) =>
    row.status === "pending" || row.status === "revision_requested",
  );
  const durablePathReason = issue.assigneeUserId
    ? "user_owner"
    : blockers.length > 0
      ? "blocker"
      : issue.monitorNextCheckAt && issue.monitorNextCheckAt.getTime() > Date.now()
        ? "monitor"
        : pendingExecutionState?.status === "pending"
          ? "execution_stage"
          : pendingInteraction
            ? "interaction"
            : pendingApproval
              ? "approval"
              : null;

  const durableState = {
    source: {
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      executionPolicy: issue.executionPolicy,
      executionState: issue.executionState,
      monitorNextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? null,
    },
    blockers: blockers.sort((a, b) => a.id.localeCompare(b.id)),
    children: children.sort((a, b) => a.id.localeCompare(b.id)),
    interactions: interactions
      .map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    approvals: linkedApprovals
      .map((row) => ({ ...row, decidedAt: row.decidedAt?.toISOString() ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    workProducts: workProducts
      .map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const digest = createHash("sha256").update(stableJson(durableState)).digest("hex");

  return {
    fingerprint: `disposition_repair:v1:${digest}`,
    dependencyIssueIds: [...new Set([...blockers.map((row) => row.id), ...children.map((row) => row.id)])],
    hasActiveExecutionPath: activeRuns.length > 0 || queuedWakes.length > 0,
    hasDurableWaitingPath: durablePathReason !== null,
    durablePathReason,
  };
}
