import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildIssueBlockersResolvedWakeStateKey,
} from "../services/issue-dependency-wakeups.ts";

// The first test in this suite imports the large `routes/issues.ts` module
// through `vi.importActual` inside `createApp`. `vi.resetModules()` in
// `beforeEach` forces a fresh import each test, so the first test pays the
// one-time transform and execution cost of that module. Locally the first
// test takes about 3.7s while the later tests take about 0.13s each. Under
// the loaded serial shard (maxWorkers=1) this cold-start can cross vitest's
// default 5000ms test timeout and produce a flaky "Test timed out in 5000ms"
// failure. Give the suite generous headroom, far above the observed cold-start
// yet still below the 30s hook timeout.
vi.setConfig({ testTimeout: 30000 });

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockFindExistingIssueBlockersResolvedWakeForReadyState = vi.hoisted(() => vi.fn(async () => null));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1" })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWakeForReadyState:
      mockFindExistingIssueBlockersResolvedWakeForReadyState,
  };
});

async function createApp() {
  const emptyRows: unknown[] = [];
  const whereResult = {
    limit: vi.fn(async () => emptyRows),
    orderBy: vi.fn(function orderBy() {
      return whereResult;
    }),
    then: async (resolve: (rows: unknown[]) => unknown) => resolve(emptyRows),
  };
  const query: Record<string, unknown> = {};
  query.innerJoin = vi.fn(() => query);
  query.leftJoin = vi.fn(() => query);
  query.where = vi.fn(() => whereResult);
  // De route logt na een update nog de geslaagde run-handoff; zonder `orderBy`
  // klapt die beste-effort-tak op deze dummy-db om en logt hij een fout.
  query.orderBy = vi.fn(() => whereResult);
  const routeDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => query),
    })),
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  };
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

const BOARD_ISSUE = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  identifier: "PAP-100",
  title: "Wachten op de prijslijst",
  description: null,
  status: "in_progress",
  priority: "medium",
  parentId: null,
  assigneeAgentId: "agent-1",
  assigneeUserId: null,
  createdByAgentId: null,
  createdByUserId: null,
  executionWorkspaceId: null,
  executionPolicy: null,
  blockedByIssueIds: [],
  blockedTransitionAt: null,
  blockedOwnerNotifiedAt: null,
  labels: [],
  labelIds: [],
};

/**
 * Een mens (board-actor) parkeert een taak zonder blokkerende issue.
 *
 * De server weigert `blocked` zonder escape: unresolved blocker, pending
 * interactie, pending approval of `unblockDescriptor` (de 422 op
 * `enteringBlocked`). De UI levert die laatste; deze suite legt vast dat de
 * route haar accepteert, en de negatieve controle legt vast dat de 422 zonder
 * escape nog steeds staat. Beide stukken samen zijn het verschil tussen een
 * escape en een versoepelde poort.
 */
describe("parkeren van een taak door een mens (board)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockFindExistingIssueBlockersResolvedWakeForReadyState.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: BOARD_ISSUE.id,
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getById.mockResolvedValue(BOARD_ISSUE);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...BOARD_ISSUE,
      ...patch,
    }));
  });

  it("accepteert blocked met een unblockDescriptor, zonder blokker", async () => {
    const unblockDescriptor = {
      owner: "board" as const,
      action: "Wachten op de prijslijst van de leverancier.",
    };

    const res = await request(await createApp())
      .patch(`/api/issues/${BOARD_ISSUE.id}`)
      .send({ status: "blocked", unblockDescriptor });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const patch = mockIssueService.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(patch.status).toBe("blocked");
    expect(patch.unblockDescriptor).toEqual(unblockDescriptor);
  });

  it("weigert dezelfde stap zonder escape (negatieve controle)", async () => {
    const res = await request(await createApp())
      .patch(`/api/issues/${BOARD_ISSUE.id}`)
      .send({ status: "blocked" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(
      "Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor",
    );
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("weigert een descriptor zonder blocked-status, want de escape hoort bij de parkeerstap", async () => {
    const res = await request(await createApp())
      .patch(`/api/issues/${BOARD_ISSUE.id}`)
      .send({
        status: "in_progress",
        unblockDescriptor: { owner: "board", action: "Wachten." },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("unblockDescriptor requires blocked status");
  });

  it("weigert een userId die geen actief bedrijfslid is, waarom de dialoog op board begint", async () => {
    const res = await request(await createApp())
      .patch(`/api/issues/${BOARD_ISSUE.id}`)
      .send({
        status: "blocked",
        unblockDescriptor: { owner: { userId: "user-zonder-lidmaatschap" }, action: "Wachten." },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unblock owner user must be an active company member");
  });
});
