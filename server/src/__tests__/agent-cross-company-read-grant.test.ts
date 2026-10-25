/**
 * THE-40 Variant A: read-only cross-company leeskanaal voor een aangewezen
 * Holding-agent (eerste gebruiker: COO Milan).
 *
 * Covers, naast `agent-cross-tenant-authz-routes.test.ts`:
 *  1. granted read  — Holding-agent-JWT met grant haalt REK-issues read-only op (HTTP 200)
 *  2. denied read   — zonder grant exact het huidige gedrag (403 / 404, geen regressie)
 *  3. denied write  — met grant blijft elke schrijfactie HTTP 403
 *
 * Fail-closed contract: `PAPERCLIP_CROSS_COMPANY_READ_GRANTS` leeg of afwezig
 * => geen enkele cross-company toegang verandert.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, companies, agents, issues, activityLog } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  assertCompanyAccess,
  assertCompanyAccessWithCrossCompanyReadGrant,
  getAccessibleResource,
  getAccessibleResourceWithCrossCompanyReadGrant,
  hasCompanyAccess,
} from "../routes/authz.js";
import { authorizationService } from "../services/authorization.js";
import { auditCrossCompanyReadGrant } from "../services/cross-company-read-audit.js";
import {
  CROSS_COMPANY_READ_GRANTS_ENV_VAR,
  hasCrossCompanyReadGrant,
  isCrossCompanyReadAction,
  parseCrossCompanyReadGrants,
} from "../services/cross-company-read-grants.js";

const HOLDING_AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REK_COMPANY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function grantEnv(value: string | undefined) {
  if (value === undefined) delete process.env[CROSS_COMPANY_READ_GRANTS_ENV_VAR];
  else process.env[CROSS_COMPANY_READ_GRANTS_ENV_VAR] = value;
}

describe("cross-company read grant parsing (fail-closed)", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[CROSS_COMPANY_READ_GRANTS_ENV_VAR];
  });
  afterEach(() => {
    grantEnv(previous);
  });

  it("parses explicit agent:company pairs", () => {
    const grants = parseCrossCompanyReadGrants(`${HOLDING_AGENT}:${REK_COMPANY}`);
    expect(grants.get(HOLDING_AGENT)?.has(REK_COMPANY)).toBe(true);
  });

  it("stays empty (fail-closed) on missing, blank or malformed input", () => {
    for (const raw of [undefined, null, "", "   ", "not-a-pair", "no-colon-here,", `${HOLDING_AGENT}`, `:${REK_COMPANY}`, "short:ids"]) {
      expect(parseCrossCompanyReadGrants(raw as string | null | undefined).size, JSON.stringify(raw)).toBe(0);
    }
  });

  it("drops malformed entries but keeps valid ones", () => {
    const grants = parseCrossCompanyReadGrants(`junk, ${HOLDING_AGENT}:${REK_COMPANY}, also-junk`);
    expect(grants.size).toBe(1);
    expect(grants.get(HOLDING_AGENT)?.has(REK_COMPANY)).toBe(true);
  });

  it("matches case-insensitively", () => {
    const grants = parseCrossCompanyReadGrants(`${HOLDING_AGENT.toUpperCase()}:${REK_COMPANY.toUpperCase()}`);
    expect(grants.get(HOLDING_AGENT)?.has(REK_COMPANY)).toBe(true);
  });

  it("denies by default when the env var is absent", () => {
    grantEnv(undefined);
    expect(hasCrossCompanyReadGrant(HOLDING_AGENT, REK_COMPANY)).toBe(false);
  });

  it("grants only the listed agent/company pair", () => {
    grantEnv(`${HOLDING_AGENT}:${REK_COMPANY}`);
    expect(hasCrossCompanyReadGrant(HOLDING_AGENT, REK_COMPANY)).toBe(true);
    expect(hasCrossCompanyReadGrant(HOLDING_AGENT, OTHER_COMPANY)).toBe(false);
    expect(hasCrossCompanyReadGrant(randomUUID(), REK_COMPANY)).toBe(false);
    expect(hasCrossCompanyReadGrant(null, REK_COMPANY)).toBe(false);
    expect(hasCrossCompanyReadGrant(HOLDING_AGENT, null)).toBe(false);
  });

  it("limits the grant to issue/agent reads (ADR scope; CISO eis 3)", () => {
    expect(isCrossCompanyReadAction("issue:read")).toBe(true);
    expect(isCrossCompanyReadAction("agent:read")).toBe(true);
    for (const action of ["project:read", "company_scope:read", "decision_queue:read", "issue:comment", "issue:mutate", "secrets:read", "secrets:propose", "agent:wake", "agent_config:read", "agent_config:update", "runtime:manage", "decision_queue:manage"] as const) {
      expect(isCrossCompanyReadAction(action), action).toBe(false);
    }
  });
});

describe("cross-company read grant route authorization", () => {
  let previous: string | undefined;
  const store = new Map<string, { id: string; companyId: string; title: string }>();

  function buildApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    // Shared helpers = out-of-scope proxy (assets/dashboard/pipelines/skills
    // pattern): fail-closed, no grant short-circuit (THE-56 Voorwaarde 1).
    app.get("/t/:companyId", (req, res, next) => {
      try {
        assertCompanyAccess(req, req.params.companyId as string);
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    });
    app.post("/t/:companyId", (req, res, next) => {
      try {
        assertCompanyAccess(req, req.params.companyId as string);
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    });
    // Enumerated ADR surfaces: grant-aware gates (issue.list/agent.list,
    // issue.get/agent.get pattern).
    app.get("/t-grant/:companyId", (req, res, next) => {
      try {
        assertCompanyAccessWithCrossCompanyReadGrant(req, req.params.companyId as string);
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    });
    app.post("/t-grant/:companyId", (req, res, next) => {
      try {
        assertCompanyAccessWithCrossCompanyReadGrant(req, req.params.companyId as string);
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    });
    app.get("/r/:id", async (req, res) => {
      const resource = await getAccessibleResource(req, res, store.get(req.params.id) ?? null, "Thing not found");
      if (!resource) return;
      res.json(resource);
    });
    app.get("/r-grant/:id", async (req, res) => {
      const resource = await getAccessibleResourceWithCrossCompanyReadGrant(req, res, store.get(req.params.id) ?? null, "Thing not found");
      if (!resource) return;
      res.json(resource);
    });
    app.get("/gate/:companyId", (req, res) => {
      res.json({ access: hasCompanyAccess(req, req.params.companyId as string) });
    });
    app.use(errorHandler);
    return app;
  }

  const holdingActor = {
    type: "agent",
    agentId: HOLDING_AGENT,
    companyId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    source: "agent_jwt",
    runId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  };

  beforeEach(() => {
    previous = process.env[CROSS_COMPANY_READ_GRANTS_ENV_VAR];
    store.clear();
    store.set("thing-1", { id: "thing-1", companyId: REK_COMPANY, title: "REK thing" });
  });
  afterEach(() => {
    grantEnv(previous);
  });

  it("granted read: alleen de ge-enumereerde ADR-oppervlakken openen (HTTP 200)", async () => {
    grantEnv(`${HOLDING_AGENT}:${REK_COMPANY}`);
    const app = buildApp(holdingActor);

    // In-scope (issue.list/agent.list- en issue.get/agent.get-patroon).
    await request(app).get(`/t-grant/${REK_COMPANY}`).expect(200);
    const res = await request(app).get("/r-grant/thing-1").expect(200);
    expect(res.body).toMatchObject({ id: "thing-1", companyId: REK_COMPANY });
  });

  it("out-of-scope: granted agent krijgt 403/404 op gedeelde helpers (assets/dashboard-patroon)", async () => {
    grantEnv(`${HOLDING_AGENT}:${REK_COMPANY}`);
    const app = buildApp(holdingActor);

    // Gedeelde `assertCompanyAccess` (dashboard/recovery-observability/
    // sidebar-badges/pipelines-patroon): 403, grant of niet.
    const denied = await request(app).get(`/t/${REK_COMPANY}`).expect(403);
    expect(denied.body.error).toBe("Agent key cannot access another company");

    // Gedeelde `getAccessibleResource` (assets/:id/content-patroon): 404,
    // geen content-exfiltratie via de grant.
    const gated = await request(app).get("/r/thing-1").expect(404);
    expect(gated.body.error).toBe("Thing not found");

    // Existence-gate `hasCompanyAccess` blijft false voor cross-company.
    const gate = await request(app).get(`/gate/${REK_COMPANY}`).expect(200);
    expect(gate.body).toMatchObject({ access: false });
  });

  it("denied read: zonder grant exact het huidige gedrag (403 + 404-orakel intact)", async () => {
    grantEnv(undefined);
    const app = buildApp(holdingActor);

    const denied = await request(app).get(`/t/${REK_COMPANY}`).expect(403);
    expect(denied.body.error).toBe("Agent key cannot access another company");

    // Via de existence-gate: ungranted cross-tenant blijft 404 (geen orakel).
    const gated = await request(app).get("/r/thing-1").expect(404);
    expect(gated.body.error).toBe("Thing not found");

    // Ook de grant-aware gates blijven dicht zonder grant.
    await request(app).get(`/t-grant/${REK_COMPANY}`).expect(403);
    await request(app).get("/r-grant/thing-1").expect(404);
  });

  it("denied write: met grant blijft elke schrijfactie HTTP 403 (ook op ADR-oppervlak)", async () => {
    grantEnv(`${HOLDING_AGENT}:${REK_COMPANY}`);
    const app = buildApp(holdingActor);

    const denied = await request(app).post(`/t/${REK_COMPANY}`).send({ title: "poging tot schrijven" }).expect(403);
    expect(denied.body.error).toBe("Agent key cannot access another company");
    await request(app).post(`/t-grant/${REK_COMPANY}`).send({ title: "poging tot schrijven" }).expect(403);
  });

  it("grant voor een andere company opent niets", async () => {
    grantEnv(`${HOLDING_AGENT}:${OTHER_COMPANY}`);
    const app = buildApp(holdingActor);

    await request(app).get(`/t/${REK_COMPANY}`).expect(403);
    await request(app).get(`/t-grant/${REK_COMPANY}`).expect(403);
    await request(app).get(`/t-grant/${OTHER_COMPANY}`).expect(200);
  });

  it("compartimentering: out-of-scope route-bestanden gebruiken geen grant-aware gates (assets/dashboard/sidebar/pipelines/skills)", () => {
    // THE-56 Voorwaarde 1: de grant-aware gates mogen alleen in de vier
    // ge-enumereerde ADR-oppervlakken (issues.ts, agents.ts) voorkomen. Deze
    // statische guard bewijst dat de benoemde out-of-scope oppervlakken
    // (`GET /assets/:id/content`, `GET /companies/:id/dashboard`,
    // `/recovery-observability`, sidebar-badges, pipelines, company-skills)
    // alleen door de fail-closed gedeelde helpers worden afgeschermd.
    const outOfScopeFiles = [
      "../routes/assets.ts",
      "../routes/dashboard.ts",
      "../routes/sidebar-badges.ts",
      "../routes/pipelines.ts",
      "../routes/company-skills.ts",
    ];
    for (const relative of outOfScopeFiles) {
      let source: string;
      try {
        source = readFileSync(new URL(relative, import.meta.url), "utf8");
      } catch {
        continue;
      }
      expect(source, relative).not.toContain("WithCrossCompanyReadGrant");
      expect(source, relative).not.toContain("usedCrossCompanyReadGrant");
      // De fail-closed gate moet aanwezig blijven (niet verwijderd/verplaatst).
      expect(
        source.includes("assertCompanyAccess") ||
          source.includes("hasCompanyAccess") ||
          source.includes("getAccessibleResource"),
        `${relative} mist een company-gate`,
      ).toBe(true);
    }
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cross-company read grant authorization decisions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previous: string | undefined;

  let sourceCompanyId!: string;
  let targetCompanyId!: string;
  let actorAgentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-read-grant-");
    db = createDb(tempDb.connectionString);
    const source = await db.insert(companies).values({ name: `Grant Source ${randomUUID()}`, issuePrefix: `GS${randomUUID().slice(0, 6).toUpperCase()}` }).returning().then((rows) => rows[0]!);
    const target = await db.insert(companies).values({ name: `Grant Target ${randomUUID()}`, issuePrefix: `GT${randomUUID().slice(0, 6).toUpperCase()}` }).returning().then((rows) => rows[0]!);
    sourceCompanyId = source.id;
    targetCompanyId = target.id;
    const agent = await db.insert(agents).values({
      companyId: sourceCompanyId,
      name: `Grant Actor ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
    actorAgentId = agent.id;
    await db.insert(issues).values({ companyId: targetCompanyId, title: `Target issue ${randomUUID()}`, status: "todo", priority: "medium", originKind: "manual" });
    previous = process.env[CROSS_COMPANY_READ_GRANTS_ENV_VAR];
    process.env[CROSS_COMPANY_READ_GRANTS_ENV_VAR] = `${actorAgentId}:${targetCompanyId}`;
  }, 30_000);

  afterAll(async () => {
    grantEnv(previous);
    await tempDb?.cleanup();
  });

  it("allows granted cross-company issue:read with the grant reason", async () => {
    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgentId, companyId: sourceCompanyId, source: "agent_jwt" },
      action: "issue:read",
      resource: { type: "issue", companyId: targetCompanyId },
    });
    expect(decision).toMatchObject({ allowed: true, reason: "allow_cross_company_read_grant" });
  });

  it("keeps granted cross-company writes, comments and secrets denied", async () => {
    const authorization = authorizationService(db);
    for (const action of ["issue:comment", "issue:mutate", "secrets:read", "agent:wake", "agent_config:update"] as const) {
      await expect(authorization.decide({
        actor: { type: "agent", agentId: actorAgentId, companyId: sourceCompanyId, source: "agent_jwt" },
        action,
        resource: { type: "issue", companyId: targetCompanyId },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_company_boundary" });
    }
  });

  it("keeps ungranted cross-company reads denied (geen regressie)", async () => {
    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: actorAgentId, companyId: sourceCompanyId, source: "agent_jwt" },
      action: "issue:read",
      resource: { type: "company", companyId: OTHER_COMPANY },
    });
    expect(decision).toMatchObject({ allowed: false, reason: "deny_company_boundary" });
  });

  it("keeps non-ADR read actions denied across the boundary, grant or not", async () => {
    const authorization = authorizationService(db);
    for (const action of ["project:read", "company_scope:read", "decision_queue:read"] as const) {
      await expect(authorization.decide({
        actor: { type: "agent", agentId: actorAgentId, companyId: sourceCompanyId, source: "agent_jwt" },
        action,
        resource: { type: "issue", companyId: targetCompanyId },
      })).resolves.toMatchObject({ allowed: false, reason: "deny_company_boundary" });
    }
  });
});

describeEmbeddedPostgres("cross-company read grant audit rows (CISO eis 1+2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previous: string | undefined;

  let sourceCompanyId!: string;
  let targetCompanyId!: string;
  let actorAgentId!: string;
  let targetIssueId!: string;

  function fakeReq(method: string) {
    return {
      method,
      actor: {
        type: "agent",
        agentId: actorAgentId,
        companyId: sourceCompanyId,
        source: "agent_jwt",
        // runId null: geen heartbeat-run-context; activity_log.run_id heeft
        // een FK naar heartbeat_runs, dus geen willekeurige UUID gebruiken.
        runId: null,
        keyId: null,
        onBehalfOfUserId: null,
      },
    } as unknown as Parameters<typeof auditCrossCompanyReadGrant>[1];
  }

  async function auditRows() {
    return db
      .select({
        companyId: activityLog.companyId,
        actorId: activityLog.actorId,
        agentId: activityLog.agentId,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
      })
      .from(activityLog)
      .where(eq(activityLog.action, "cross_company.read"));
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-company-read-audit-");
    db = createDb(tempDb.connectionString);
    const source = await db.insert(companies).values({ name: `Audit Source ${randomUUID()}`, issuePrefix: `AS${randomUUID().slice(0, 6).toUpperCase()}` }).returning().then((rows) => rows[0]!);
    const target = await db.insert(companies).values({ name: `Audit Target ${randomUUID()}`, issuePrefix: `AT${randomUUID().slice(0, 6).toUpperCase()}` }).returning().then((rows) => rows[0]!);
    sourceCompanyId = source.id;
    targetCompanyId = target.id;
    const agent = await db.insert(agents).values({
      companyId: sourceCompanyId,
      name: `Audit Actor ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    }).returning().then((rows) => rows[0]!);
    actorAgentId = agent.id;
    const issue = await db.insert(issues).values({ companyId: targetCompanyId, title: `Audit issue ${randomUUID()}`, status: "todo", priority: "medium", originKind: "manual" }).returning().then((rows) => rows[0]!);
    targetIssueId = issue.id;
    previous = process.env[CROSS_COMPANY_READ_GRANTS_ENV_VAR];
    process.env[CROSS_COMPANY_READ_GRANTS_ENV_VAR] = `${actorAgentId}:${targetCompanyId}`;
  }, 30_000);

  afterAll(async () => {
    grantEnv(previous);
    await tempDb?.cleanup();
  });

  it("granted read schrijft precies één cross_company.read-row met juiste agent/company", async () => {
    const before = await auditRows();
    const written = await auditCrossCompanyReadGrant(db, fakeReq("GET"), {
      companyId: targetCompanyId,
      entityType: "issue",
      entityId: targetIssueId,
      surface: "issue.get",
    });
    expect(written).toBe(true);
    const after = await auditRows();
    expect(after.length - before.length).toBe(1);
    expect(after[after.length - 1]).toMatchObject({
      companyId: targetCompanyId,
      actorId: actorAgentId,
      agentId: actorAgentId,
      action: "cross_company.read",
      entityType: "issue",
      entityId: targetIssueId,
    });
  });

  it("agent-oppervlakken schrijven elk precies één cross_company.read-row (Voorwaarde 2)", async () => {
    for (const input of [
      { companyId: targetCompanyId, entityType: "company" as const, entityId: targetCompanyId, surface: "agent.list" as const },
      { companyId: targetCompanyId, entityType: "agent" as const, entityId: actorAgentId, surface: "agent.get" as const },
      { companyId: targetCompanyId, entityType: "company" as const, entityId: targetCompanyId, surface: "issue.list" as const },
    ]) {
      const before = await auditRows();
      const written = await auditCrossCompanyReadGrant(db, fakeReq("GET"), input);
      expect(written).toBe(true);
      const after = await auditRows();
      expect(after.length - before.length, input.surface).toBe(1);
      expect(after[after.length - 1]).toMatchObject({
        companyId: targetCompanyId,
        actorId: actorAgentId,
        agentId: actorAgentId,
        action: "cross_company.read",
        entityType: input.entityType,
        entityId: input.entityId,
      });
    }
  });

  it("denied read en denied write schrijven geen audit-row", async () => {
    const before = await auditRows();
    // Ongranted company (read): geen row.
    await expect(auditCrossCompanyReadGrant(db, fakeReq("GET"), {
      companyId: OTHER_COMPANY,
      entityType: "company",
      entityId: OTHER_COMPANY,
      surface: "issue.list",
    })).resolves.toBe(false);
    // Granted company maar write-methode: geen row.
    await expect(auditCrossCompanyReadGrant(db, fakeReq("POST"), {
      companyId: targetCompanyId,
      entityType: "issue",
      entityId: targetIssueId,
      surface: "issue.get",
    })).resolves.toBe(false);
    expect(await auditRows()).toHaveLength(before.length);
  });
});
