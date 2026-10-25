/**
 * Audit helper for THE-40 Variant A cross-company reads.
 *
 * Every read materialized through the explicit per-agent grant is written to
 * `activity_log` with action `cross_company.read` — mirroring how secret
 * reads are audited. Extracted here (instead of a route closure) so the
 * audit contract is unit-testable against a real database.
 *
 * Placement rationale (CISO eis 1, THE-46): the write lives at the route
 * surfaces where a granted read actually materializes (`issue.list`,
 * `issue.get`, `agent.list`, `agent.get`), exactly once per API call — not at
 * the `decide()` allow point. `decide()` is also invoked speculatively
 * (memoized read checks, per-row list filtering) without knowledge of the
 * HTTP method or the responding entity, so auditing there would emit rows for
 * checks that never become a response, or N rows per list call.
 */
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { getActorInfo, usedCrossCompanyReadGrant } from "../routes/authz.js";
import { CROSS_COMPANY_READ_GRANT_AUDIT_ACTION } from "./cross-company-read-grants.js";
import { logActivity } from "./activity-log.js";

export type CrossCompanyReadAuditInput = {
  companyId: string;
  entityType: "company" | "issue" | "agent";
  entityId: string;
  surface: "issue.list" | "issue.get" | "agent.list" | "agent.get";
};

/**
 * Write one `cross_company.read` audit row when (and only when) this request
 * reads another company through an explicit per-agent grant. Returns true
 * when a row was written. Same-company reads and ungranted cross-company
 * reads never write (fail-closed, no audit noise).
 */
export async function auditCrossCompanyReadGrant(
  db: Db,
  req: Request,
  input: CrossCompanyReadAuditInput,
): Promise<boolean> {
  if (!usedCrossCompanyReadGrant(req, input.companyId)) return false;
  const actor = getActorInfo(req);
  await logActivity(db, {
    companyId: input.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    action: CROSS_COMPANY_READ_GRANT_AUDIT_ACTION,
    entityType: input.entityType,
    entityId: input.entityId,
    details: {
      surface: input.surface,
      grant: "cross_company_read",
      actorCompanyId: req.actor.companyId ?? null,
    },
  });
  return true;
}
