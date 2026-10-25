/**
 * Cross-company read grants for designated Holding agents (THE-40, Variant A).
 *
 * Fail-closed by design: without an explicit, per-agent grant in
 * `PAPERCLIP_CROSS_COMPANY_READ_GRANTS`, every cross-company agent access
 * keeps the exact current behavior (403 "Agent key cannot access another
 * company" / 404 oracle-preserving denials).
 *
 * Grant format (env var `PAPERCLIP_CROSS_COMPANY_READ_GRANTS`):
 *   "<agentId>:<targetCompanyId>,<agentId>:<targetCompanyId>,..."
 * UUID comparison is case-insensitive; surrounding whitespace is ignored;
 * malformed entries are skipped (never fail-open).
 *
 * The grant is READ-ONLY and surface-scoped (THE-56):
 * - route layer (`routes/authz.ts`): only safe methods (GET/HEAD/OPTIONS) on
 *   the four enumerated ADR surfaces (`issue.list`, `issue.get`,
 *   `agent.list`, `agent.get`) via the explicit grant-aware gates. The shared
 *   `assertCompanyAccess` / `hasCompanyAccess` / `getAccessibleResource`
 *   helpers stay fail-closed; every non-safe method stays 403, grant or not.
 * - service layer (`services/authorization.ts`): only the actions in
 *   CROSS_COMPANY_READ_ACTIONS; everything else (writes, comments, secrets,
 *   wake, runtime, manage) stays denied.
 *
 * No board-actor imitation: the grant never changes `actor.type`; it only
 * widens the company-boundary check for the listed read actions.
 */
import type { AuthorizationAction } from "./authorization.js";

export const CROSS_COMPANY_READ_GRANTS_ENV_VAR = "PAPERCLIP_CROSS_COMPANY_READ_GRANTS";

/** `activity_log` action recorded for every granted cross-company read. */
export const CROSS_COMPANY_READ_GRANT_AUDIT_ACTION = "cross_company.read";

/**
 * Service-layer actions a cross-company read grant may allow. Exact ADR
 * scope ("issues/agents-reads", THE-40): `issue:read` and `agent:read`
 * only. Everything not listed here — including `project:read`,
 * `company_scope:read`, `decision_queue:read`, `secrets:read`,
 * `agent:wake`, `agent_config:read`, `issue:comment`, `issue:mutate` and
 * all `:manage`/`:update` actions — stays denied across the company
 * boundary, grant or not (CISO eis 3, THE-46).
 */
export const CROSS_COMPANY_READ_ACTIONS: ReadonlySet<AuthorizationAction> = new Set([
  "agent:read",
  "issue:read",
]);

export function isCrossCompanyReadAction(action: AuthorizationAction): boolean {
  return CROSS_COMPANY_READ_ACTIONS.has(action);
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/**
 * Parse the raw env value into agentId -> target companyIds. Pure function so
 * it stays unit-testable without env access. Never throws; malformed entries
 * are dropped (fail-closed).
 */
export function parseCrossCompanyReadGrants(raw: string | null | undefined): Map<string, Set<string>> {
  const grants = new Map<string, Set<string>>();
  if (!raw) return grants;
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) continue;
    const agentId = normalizeId(trimmed.slice(0, separatorIndex));
    const companyId = normalizeId(trimmed.slice(separatorIndex + 1));
    if (!agentId || !companyId) continue;
    // Require plausible UUID shape on both sides so typos cannot widen access
    // to a prefix-matched or empty identity.
    if (!isUuidLike(agentId) || !isUuidLike(companyId)) continue;
    const existing = grants.get(agentId);
    if (existing) existing.add(companyId);
    else grants.set(agentId, new Set([companyId]));
  }
  return grants;
}

export function hasCrossCompanyReadGrant(
  agentId: string | null | undefined,
  targetCompanyId: string | null | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  if (!agentId || !targetCompanyId) return false;
  const raw = env[CROSS_COMPANY_READ_GRANTS_ENV_VAR];
  if (!raw || !raw.trim()) return false;
  const grants = parseCrossCompanyReadGrants(raw);
  return grants.get(normalizeId(agentId))?.has(normalizeId(targetCompanyId)) ?? false;
}
