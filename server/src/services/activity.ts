import { executionProjectionsForRuns } from "./execution-projection.js";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
  issueWorkProducts,
  workspaceOperations,
} from "@paperclipai/db";
import { hasWorkspaceRestoreFailure, safeWorkspaceRestorePath, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { classifyRunLiveness } from "./run-liveness.js";
import { detoastedJsonbKeys } from "./jsonb-detoast.js";

export interface ActivityFilters {
  companyId: string;
  agentId?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
}

const DEFAULT_ACTIVITY_LIMIT = 100;
const MAX_ACTIVITY_LIMIT = 500;

export function normalizeActivityLimit(limit: number | undefined) {
  if (!Number.isFinite(limit)) return DEFAULT_ACTIVITY_LIMIT;
  return Math.max(1, Math.min(MAX_ACTIVITY_LIMIT, Math.floor(limit ?? DEFAULT_ACTIVITY_LIMIT)));
}

export function activityService(db: Db) {
  const scheduledLivenessBackfills = new Set<string>();
  const issueIdAsText = sql<string>`${issues.id}::text`;
  // Eén detoast per brede kolom, in plaats van één per `->`. Zie jsonb-detoast.ts.
  const runUsageKeys = detoastedJsonbKeys(
    heartbeatRuns.usageJson,
    [
      "inputTokens",
      "input_tokens",
      "outputTokens",
      "output_tokens",
      "cachedInputTokens",
      "cached_input_tokens",
      "cache_read_input_tokens",
      "billingType",
      "billing_type",
      "costUsd",
      "cost_usd",
      "total_cost_usd",
    ],
    "run_usage",
  );
  const runResultKeys = detoastedJsonbKeys(
    heartbeatRuns.resultJson,
    [
      "conversationReset",
      "workspaceRestoreFailure",
      "workspaceRestorePath",
      "finalResponseRecorded",
      "billingType",
      "billing_type",
      "costUsd",
      "cost_usd",
      "total_cost_usd",
      "stopReason",
      "effectiveTimeoutSec",
      "effectiveTimeoutMs",
      "timeoutConfigured",
      "timeoutSource",
      "timeoutFired",
    ],
    "run_result",
  );
  const runContextKeys = detoastedJsonbKeys(
    heartbeatRuns.contextSnapshot,
    ["wakeCommentIds", "wakeCommentId", "commentId", "issueId"],
    "run_context",
  );
  const summarizedUsageJson = sql<Record<string, unknown> | null>`
    case
      when ${heartbeatRuns.usageJson} is null then null
      else jsonb_strip_nulls(jsonb_build_object(
        'inputTokens', coalesce(${runUsageKeys.jsonb("inputTokens")}, ${runUsageKeys.jsonb("input_tokens")}),
        'input_tokens', coalesce(${runUsageKeys.jsonb("input_tokens")}, ${runUsageKeys.jsonb("inputTokens")}),
        'outputTokens', coalesce(${runUsageKeys.jsonb("outputTokens")}, ${runUsageKeys.jsonb("output_tokens")}),
        'output_tokens', coalesce(${runUsageKeys.jsonb("output_tokens")}, ${runUsageKeys.jsonb("outputTokens")}),
        'cachedInputTokens', coalesce(
          ${runUsageKeys.jsonb("cachedInputTokens")},
          ${runUsageKeys.jsonb("cached_input_tokens")},
          ${runUsageKeys.jsonb("cache_read_input_tokens")}
        ),
        'cached_input_tokens', coalesce(
          ${runUsageKeys.jsonb("cached_input_tokens")},
          ${runUsageKeys.jsonb("cachedInputTokens")},
          ${runUsageKeys.jsonb("cache_read_input_tokens")}
        ),
        'cache_read_input_tokens', coalesce(
          ${runUsageKeys.jsonb("cache_read_input_tokens")},
          ${runUsageKeys.jsonb("cached_input_tokens")},
          ${runUsageKeys.jsonb("cachedInputTokens")}
        ),
        'billingType', coalesce(${runUsageKeys.jsonb("billingType")}, ${runUsageKeys.jsonb("billing_type")}),
        'billing_type', coalesce(${runUsageKeys.jsonb("billing_type")}, ${runUsageKeys.jsonb("billingType")}),
        'costUsd', coalesce(
          ${runUsageKeys.jsonb("costUsd")},
          ${runUsageKeys.jsonb("cost_usd")},
          ${runUsageKeys.jsonb("total_cost_usd")}
        ),
        'cost_usd', coalesce(
          ${runUsageKeys.jsonb("cost_usd")},
          ${runUsageKeys.jsonb("costUsd")},
          ${runUsageKeys.jsonb("total_cost_usd")}
        ),
        'total_cost_usd', coalesce(
          ${runUsageKeys.jsonb("total_cost_usd")},
          ${runUsageKeys.jsonb("cost_usd")},
          ${runUsageKeys.jsonb("costUsd")}
        )
      ))
    end
  `.as("usageJson");
  const summarizedResultJson = sql<Record<string, unknown> | null>`
    case
      when ${heartbeatRuns.resultJson} is null then null
      else jsonb_strip_nulls(jsonb_build_object(
        'conversationReset', ${runResultKeys.jsonb("conversationReset")},
        'workspaceRestoreFailure', case when ${runResultKeys.text("workspaceRestoreFailure")}
          in ('restore_permission_denied', 'restore_lock_timeout', 'restore_unsafe_archive', 'restore_failed')
          then ${runResultKeys.jsonb("workspaceRestoreFailure")} end,
        'workspaceRestorePath', case when length(${runResultKeys.text("workspaceRestorePath")}) <= 180
          then ${runResultKeys.jsonb("workspaceRestorePath")} end,
        'finalResponseRecorded', case when jsonb_typeof(${runResultKeys.jsonb("finalResponseRecorded")}) = 'boolean'
          then ${runResultKeys.jsonb("finalResponseRecorded")} end,
        'billingType', coalesce(${runResultKeys.jsonb("billingType")}, ${runResultKeys.jsonb("billing_type")}),
        'billing_type', coalesce(${runResultKeys.jsonb("billing_type")}, ${runResultKeys.jsonb("billingType")}),
        'costUsd', coalesce(
          ${runResultKeys.jsonb("costUsd")},
          ${runResultKeys.jsonb("cost_usd")},
          ${runResultKeys.jsonb("total_cost_usd")}
        ),
        'cost_usd', coalesce(
          ${runResultKeys.jsonb("cost_usd")},
          ${runResultKeys.jsonb("costUsd")},
          ${runResultKeys.jsonb("total_cost_usd")}
        ),
        'total_cost_usd', coalesce(
          ${runResultKeys.jsonb("total_cost_usd")},
          ${runResultKeys.jsonb("cost_usd")},
          ${runResultKeys.jsonb("costUsd")}
        ),
        'stopReason', ${runResultKeys.jsonb("stopReason")},
        'effectiveTimeoutSec', ${runResultKeys.jsonb("effectiveTimeoutSec")},
        'effectiveTimeoutMs', ${runResultKeys.jsonb("effectiveTimeoutMs")},
        'timeoutConfigured', ${runResultKeys.jsonb("timeoutConfigured")},
        'timeoutSource', ${runResultKeys.jsonb("timeoutSource")},
        'timeoutFired', ${runResultKeys.jsonb("timeoutFired")}
      ))
    end
  `.as("resultJson");

  function countValue(value: unknown) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  }

  function dateValue(value: unknown) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "string" || typeof value === "number") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }

  function latestDate(...values: unknown[]) {
    let latest: Date | null = null;
    for (const value of values) {
      const parsed = dateValue(value);
      if (!parsed) continue;
      if (!latest || parsed.getTime() > latest.getTime()) latest = parsed;
    }
    return latest;
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function readNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  async function backfillMissingRunLivenessForIssue(companyId: string, issueId: string) {
    const runs = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        resultJson: heartbeatRuns.resultJson,
        stdoutExcerpt: heartbeatRuns.stdoutExcerpt,
        stderrExcerpt: heartbeatRuns.stderrExcerpt,
        error: heartbeatRuns.error,
        errorCode: heartbeatRuns.errorCode,
        continuationAttempt: heartbeatRuns.continuationAttempt,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          isNull(heartbeatRuns.livenessState),
          sql`${heartbeatRuns.status} not in ('queued', 'running')`,
          or(
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
            sql`exists (
              select 1
              from ${activityLog}
              where ${activityLog.companyId} = ${companyId}
                and ${activityLog.entityType} = 'issue'
                and ${activityLog.entityId} = ${issueId}
                and ${activityLog.runId} = ${heartbeatRuns.id}
            )`,
          ),
        ),
      )
      .limit(20);

    if (runs.length === 0) return;

    const issue = await db
      .select({
        status: issues.status,
        title: issues.title,
        description: issues.description,
        workMode: issues.workMode,
      })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
      .then((rows) => rows[0] ?? null);

    for (const run of runs) {
      const context = asRecord(run.contextSnapshot);
      const continuationAttempt =
        readNumber(context?.continuationAttempt) ??
        readNumber(context?.livenessContinuationAttempt) ??
        run.continuationAttempt ??
        0;

      const [commentStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${issueComments.createdAt})`,
        })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.companyId, companyId),
            eq(issueComments.issueId, issueId),
            eq(issueComments.createdByRunId, run.id),
          ),
        );

      const [documentStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          planCount: sql<number>`count(*) filter (where ${issueDocuments.key} = 'plan')::int`,
          latestAt: sql<Date | null>`max(${documentRevisions.createdAt})`,
        })
        .from(documentRevisions)
        .innerJoin(issueDocuments, eq(documentRevisions.documentId, issueDocuments.documentId))
        .where(
          and(
            eq(documentRevisions.companyId, companyId),
            eq(documentRevisions.createdByRunId, run.id),
            eq(issueDocuments.companyId, companyId),
            eq(issueDocuments.issueId, issueId),
            sql`${issueDocuments.key} != ${ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY}`,
          ),
        );

      const [workProductStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${issueWorkProducts.createdAt})`,
        })
        .from(issueWorkProducts)
        .where(
          and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.issueId, issueId),
            eq(issueWorkProducts.createdByRunId, run.id),
          ),
        );

      const [workspaceOperationStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${workspaceOperations.startedAt})`,
        })
        .from(workspaceOperations)
        .where(and(eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.heartbeatRunId, run.id)));

      const [activityStats] = await db
        .select({
          count: sql<number>`count(*)::int`,
          latestAt: sql<Date | null>`max(${activityLog.createdAt})`,
        })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, run.id)));

      const [eventStats] = await db
        .select({
          count: sql<number>`count(*) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))::int`,
          latestAt: sql<Date | null>`max(${heartbeatRunEvents.createdAt}) filter (where ${heartbeatRunEvents.eventType} not in ('lifecycle', 'adapter.invoke', 'error'))`,
        })
        .from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, run.id)));

      const classification = classifyRunLiveness({
        runStatus: run.status,
        issue,
        resultJson: asRecord(run.resultJson),
        stdoutExcerpt: run.stdoutExcerpt,
        stderrExcerpt: run.stderrExcerpt,
        error: run.error,
        errorCode: run.errorCode,
        continuationAttempt,
        evidence: {
          issueCommentsCreated: countValue(commentStats?.count),
          documentRevisionsCreated: countValue(documentStats?.count),
          planDocumentRevisionsCreated: countValue(documentStats?.planCount),
          workProductsCreated: countValue(workProductStats?.count),
          workspaceOperationsCreated: countValue(workspaceOperationStats?.count),
          activityEventsCreated: countValue(activityStats?.count),
          toolOrActionEventsCreated: countValue(eventStats?.count),
          latestEvidenceAt: latestDate(
            commentStats?.latestAt,
            documentStats?.latestAt,
            workProductStats?.latestAt,
            workspaceOperationStats?.latestAt,
            activityStats?.latestAt,
            eventStats?.latestAt,
          ),
        },
      });

      await db
        .update(heartbeatRuns)
        .set({
          livenessState: classification.livenessState,
          livenessReason: classification.livenessReason,
          continuationAttempt: classification.continuationAttempt,
          lastUsefulActionAt: classification.lastUsefulActionAt,
          nextAction: classification.nextAction,
          updatedAt: new Date(),
        })
        .where(and(eq(heartbeatRuns.id, run.id), isNull(heartbeatRuns.livenessState)));
    }
  }

  function scheduleRunLivenessBackfill(companyId: string, issueId: string) {
    const key = `${companyId}:${issueId}`;
    if (scheduledLivenessBackfills.has(key)) return;
    scheduledLivenessBackfills.add(key);
    void backfillMissingRunLivenessForIssue(companyId, issueId)
      .catch((err: unknown) => {
        logger.warn({ err, companyId, issueId }, "run liveness backfill failed");
      })
      .finally(() => {
        scheduledLivenessBackfills.delete(key);
      });
  }

  return {
    list: (filters: ActivityFilters) => {
      const conditions = [eq(activityLog.companyId, filters.companyId)];
      const limit = normalizeActivityLimit(filters.limit);

      if (filters.agentId) {
        conditions.push(eq(activityLog.agentId, filters.agentId));
      }
      if (filters.entityType) {
        conditions.push(eq(activityLog.entityType, filters.entityType));
      }
      if (filters.entityId) {
        conditions.push(eq(activityLog.entityId, filters.entityId));
      }

      return db
        .select({ activityLog })
        .from(activityLog)
        .leftJoin(
          issues,
          and(
            eq(activityLog.entityType, sql`'issue'`),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            ...conditions,
            or(
              sql`${activityLog.entityType} != 'issue'`,
              visibleIssueCondition(),
            ),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .limit(limit)
        .then((rows) => rows.map((r) => r.activityLog));
    },

    forIssue: (issueId: string) =>
      db
        .select()
        .from(activityLog)
        .where(
          or(
            and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId)),
            and(or(eq(activityLog.action, "project.created"), eq(activityLog.action, "company.skill_created")), sql`${activityLog.details}->>'sourceIssueId' = ${issueId}`,
              sql`${activityLog.companyId} = (select company_id from issues where id = ${issueId})`),
          ),
        )
        .orderBy(desc(activityLog.createdAt)),

    runsForIssue: async (companyId: string, issueId: string) => {
      scheduleRunLivenessBackfill(companyId, issueId);
      const runs = await db
        .select({
          runId: heartbeatRuns.id,
          runtimeMode: heartbeatRuns.runtimeMode,
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          adapterType: agents.adapterType,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          invocationSource: heartbeatRuns.invocationSource,
          responsibleUserId: heartbeatRuns.responsibleUserId,
          errorCode: heartbeatRuns.errorCode,
          usageJson: summarizedUsageJson,
          resultJson: summarizedResultJson,
          logBytes: heartbeatRuns.logBytes,
          retryOfRunId: heartbeatRuns.retryOfRunId,
          scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
          scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
          scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
          livenessState: heartbeatRuns.livenessState,
          livenessReason: heartbeatRuns.livenessReason,
          continuationAttempt: heartbeatRuns.continuationAttempt,
          lastUsefulActionAt: heartbeatRuns.lastUsefulActionAt,
          nextAction: heartbeatRuns.nextAction,
          wakeCommentIds: runContextKeys.jsonb("wakeCommentIds") as SQL<string[] | null>,
          wakeCommentId: runContextKeys.text("wakeCommentId") as SQL<string | null>,
          contextCommentId: runContextKeys.text("commentId") as SQL<string | null>,
          contextIssueId: runContextKeys.text("issueId") as SQL<string | null>,
        })
        .from(heartbeatRuns)
        .innerJoin(
          agents,
          and(
            eq(agents.id, heartbeatRuns.agentId),
            eq(agents.companyId, heartbeatRuns.companyId),
          ),
        )
        .leftJoin(runContextKeys.join, sql`true`)
        .leftJoin(runUsageKeys.join, sql`true`)
        .leftJoin(runResultKeys.join, sql`true`)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            // `id in (A ∪ B)` in plaats van `A or exists(B)`. De `or`-vorm kan
            // `heartbeat_runs_company_ctx_issue_created_idx` niet gebruiken en
            // eindigt in een Seq Scan over alle runs van het bedrijf, waarbij
            // `context_snapshot ->> 'issueId'` elke TOASTed rij volledig
            // detoast. Gemeten: 1,2 s vaste kost op een issue met 3 runs.
            inArray(
              heartbeatRuns.id,
              sql`(
                select ${heartbeatRuns.id} from ${heartbeatRuns}
                where ${heartbeatRuns.companyId} = ${companyId}
                  and ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}
                union
                select ${activityLog.runId} from ${activityLog}
                where ${activityLog.companyId} = ${companyId}
                  and ${activityLog.entityType} = 'issue'
                  and ${activityLog.entityId} = ${issueId}
                  and ${activityLog.runId} is not null
              )`,
            ),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt));

      if (runs.length === 0) return runs;
      const runIds = runs.map((run) => run.runId);
      if (runIds.length === 0) return runs;

      const exhaustionRows = await db
        .select({
          runId: heartbeatRunEvents.runId,
          message: heartbeatRunEvents.message,
        })
        .from(heartbeatRunEvents)
        .where(
          and(
            inArray(heartbeatRunEvents.runId, runIds),
            eq(heartbeatRunEvents.eventType, "lifecycle"),
            sql`${heartbeatRunEvents.message} like 'Bounded retry exhausted%'`,
          ),
        )
        .orderBy(asc(heartbeatRunEvents.runId), desc(heartbeatRunEvents.id));

      const retryExhaustedReasonByRunId = new Map<string, string>();
      for (const row of exhaustionRows) {
        if (!row.message || retryExhaustedReasonByRunId.has(row.runId)) continue;
        retryExhaustedReasonByRunId.set(row.runId, row.message);
      }

      const leaseRows = await db
        .select({
          lease: environmentLeases,
          environment: {
            id: environments.id,
            name: environments.name,
            driver: environments.driver,
          },
        })
        .from(environmentLeases)
        .innerJoin(environments, eq(environmentLeases.environmentId, environments.id))
        .where(
          and(
            eq(environmentLeases.companyId, companyId),
            inArray(environmentLeases.heartbeatRunId, runIds),
          ),
        )
        .orderBy(desc(environmentLeases.lastUsedAt), desc(environmentLeases.createdAt));

      const leaseByRunId = new Map<string, (typeof leaseRows)[number]>();
      for (const row of leaseRows) {
        if (row.lease.heartbeatRunId && !leaseByRunId.has(row.lease.heartbeatRunId)) {
          leaseByRunId.set(row.lease.heartbeatRunId, row);
        }
      }

      const executionByRunId = await executionProjectionsForRuns(db, companyId, runIds);
      // Only stored, current plan revisions can support a saved-plan link.
      // Do not trust an adapter's claim that it wrote a document.
      const [savedPlan] = runs.some((run) => hasWorkspaceRestoreFailure(run.resultJson))
        ? await db.select({ revisionId: documentRevisions.id, runId: documentRevisions.createdByRunId })
          .from(issueDocuments)
          .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, companyId)))
          .innerJoin(documentRevisions, and(eq(documentRevisions.id, documents.latestRevisionId), eq(documentRevisions.documentId, documents.id), eq(documentRevisions.companyId, companyId)))
          .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, "plan")))
          .limit(1)
        : [];
      return runs.map((run) => {
        const leaseRow = leaseByRunId.get(run.runId);
        const leaseMetadata = leaseRow?.lease.metadata ?? null;
        const workspacePath =
          typeof leaseMetadata?.remoteCwd === "string" && leaseMetadata.remoteCwd.trim().length > 0
            ? leaseMetadata.remoteCwd
            : typeof leaseMetadata?.remoteWorkspacePath === "string" && leaseMetadata.remoteWorkspacePath.trim().length > 0
              ? leaseMetadata.remoteWorkspacePath
              : null;
        return {
          ...run,
          resultJson: run.resultJson ? {
            ...run.resultJson,
            ...(Object.hasOwn(run.resultJson, "workspaceRestorePath") ? {
              workspaceRestorePath: safeWorkspaceRestorePath(run.resultJson.workspaceRestorePath),
            } : {}),
            ...(hasWorkspaceRestoreFailure(run.resultJson) ? {
              ...(savedPlan?.runId === run.runId ? { savedPlanRevisionId: savedPlan.revisionId } : {}),
            } : {}),
          } : null,
          execution: executionByRunId.get(run.runId) ?? null,
          environment: leaseRow
            ? {
                id: leaseRow.environment.id,
                name: leaseRow.environment.name,
                driver: leaseRow.environment.driver,
              }
            : null,
          environmentLease: leaseRow
            ? {
                id: leaseRow.lease.id,
                status: leaseRow.lease.status,
                leasePolicy: leaseRow.lease.leasePolicy,
                provider: leaseRow.lease.provider,
                providerLeaseId: leaseRow.lease.providerLeaseId,
                executionWorkspaceId: leaseRow.lease.executionWorkspaceId,
                workspacePath,
                failureReason: leaseRow.lease.failureReason,
                cleanupStatus: leaseRow.lease.cleanupStatus,
                acquiredAt: leaseRow.lease.acquiredAt,
                releasedAt: leaseRow.lease.releasedAt,
              }
            : null,
          retryExhaustedReason: retryExhaustedReasonByRunId.get(run.runId) ?? null,
        };
      });
    },

    issuesForRun: async (runId: string) => {
      const run = await db
        .select({
          companyId: heartbeatRuns.companyId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!run) return [];

      const fromActivity = await db
        .selectDistinctOn([issueIdAsText], {
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(activityLog)
        .innerJoin(issues, eq(activityLog.entityId, issueIdAsText))
        .where(
          and(
            eq(activityLog.companyId, run.companyId),
            eq(activityLog.runId, runId),
            eq(activityLog.entityType, "issue"),
            visibleIssueCondition(),
          ),
        )
        .orderBy(issueIdAsText);

      const context = run.contextSnapshot;
      const contextIssueId =
        context && typeof context === "object" && typeof (context as Record<string, unknown>).issueId === "string"
          ? ((context as Record<string, unknown>).issueId as string)
          : null;
      if (!contextIssueId) return fromActivity;
      if (fromActivity.some((issue) => issue.issueId === contextIssueId)) return fromActivity;

      const fromContext = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, run.companyId),
            eq(issues.id, contextIssueId),
            visibleIssueCondition(),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!fromContext) return fromActivity;
      return [fromContext, ...fromActivity];
    },

    create: (data: typeof activityLog.$inferInsert) =>
      db
        .insert(activityLog)
        .values(data)
        .returning()
        .then((rows) => rows[0]),
  };
}
