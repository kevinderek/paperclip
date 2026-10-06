import { describe, expect, it } from "vitest";
import {
  decidePreDrain,
  decideQueuedCommentAction,
  decideQueuedCommentActorOwnsEntry,
  decideQueuedCommentReorder,
  decideQueuedCommentWakeLookup,
  decideReleaseRecovery,
  decideStrandedWakeFallback,
  decideWakeAdmission,
  decideWakeOutcome,
  deriveImmediateRecoveryContextLabels,
  type DeferredWakeOutcomeFacts,
  type DeferredWakeQueuedCommentFacts,
  type ImmediateRecoveryContextLabels,
  type PreDrainFacts,
  type QueuedCommentActorOwnershipFacts,
  type QueuedCommentReorderFacts,
  type QueuedCommentWakeLookupFacts,
  type ReleaseRecoveryFacts,
  type StrandedWakeFallbackFacts,
  type WakeAdmissionFacts,
} from "./policy.js";

const basePreDrainFacts: PreDrainFacts = {
  issueRowPresent: true,
  executionRunIdMatchesRun: true,
  isWorkspaceValidationFailedRun: false,
  isConfigurationIncompleteFailedRun: false,
  issueStatus: "in_progress",
  hasAssigneeUser: false,
  assigneeAgentMatchesRunAgent: true,
  legacyExecutionNeedsReconciliation: false,
  executionCancellationAcknowledged: false,
};

describe("decidePreDrain", () => {
  const cases: Array<{
    name: string;
    facts: PreDrainFacts;
    expected: ReturnType<typeof decidePreDrain>;
  }> = [
    {
      name: "released: the issue row is missing",
      facts: { ...basePreDrainFacts, issueRowPresent: false },
      expected: { kind: "released" },
    },
    {
      name: "released: another run already holds executionRunId",
      facts: { ...basePreDrainFacts, executionRunIdMatchesRun: false },
      expected: { kind: "released" },
    },
    {
      name: "blocked: a workspace-validation failure on an eligible todo issue",
      facts: { ...basePreDrainFacts, isWorkspaceValidationFailedRun: true, issueStatus: "todo" },
      expected: { kind: "blocked", noticeKind: "workspace_validation" },
    },
    {
      name: "blocked: a configuration-incomplete failure on an eligible in_progress issue",
      facts: { ...basePreDrainFacts, isConfigurationIncompleteFailedRun: true, issueStatus: "in_progress" },
      expected: { kind: "blocked", noticeKind: "configuration_incomplete" },
    },
    {
      name: "proceed: a workspace-validation failure on an issue that is not todo or in_progress",
      facts: { ...basePreDrainFacts, isWorkspaceValidationFailedRun: true, issueStatus: "in_review" },
      expected: { kind: "proceed" },
    },
    {
      name: "proceed: a workspace-validation failure but the issue already has an assigned user",
      facts: {
        ...basePreDrainFacts,
        isWorkspaceValidationFailedRun: true,
        issueStatus: "todo",
        hasAssigneeUser: true,
      },
      expected: { kind: "proceed" },
    },
    {
      name: "proceed: a workspace-validation failure but the assigned agent does not match the finishing run's agent",
      facts: {
        ...basePreDrainFacts,
        isWorkspaceValidationFailedRun: true,
        issueStatus: "todo",
        assigneeAgentMatchesRunAgent: false,
      },
      expected: { kind: "proceed" },
    },
    {
      name: "released: legacy execution needs reconciliation",
      facts: { ...basePreDrainFacts, legacyExecutionNeedsReconciliation: true },
      expected: { kind: "released" },
    },
    {
      name: "released: an acknowledged execution cancellation",
      facts: { ...basePreDrainFacts, executionCancellationAcknowledged: true },
      expected: { kind: "released" },
    },
    {
      name: "proceed: none of the pre-drain conditions apply",
      facts: basePreDrainFacts,
      expected: { kind: "proceed" },
    },
    {
      name: "the blocked-notice check is evaluated before legacy-execution reconciliation",
      facts: {
        ...basePreDrainFacts,
        isWorkspaceValidationFailedRun: true,
        issueStatus: "todo",
        // If reconciliation were checked first, this would force a "released"
        // outcome; the expected "blocked" here proves the blocked-notice
        // check, evaluated first, decides the outcome.
        legacyExecutionNeedsReconciliation: true,
      },
      expected: { kind: "blocked", noticeKind: "workspace_validation" },
    },
    {
      name: "the blocked-notice check is evaluated before an acknowledged execution cancellation",
      facts: {
        ...basePreDrainFacts,
        isConfigurationIncompleteFailedRun: true,
        issueStatus: "todo",
        // If the cancellation check were checked first, this would force a
        // "released" outcome; the expected "blocked" here proves the
        // blocked-notice check, evaluated first, decides the outcome.
        executionCancellationAcknowledged: true,
      },
      expected: { kind: "blocked", noticeKind: "configuration_incomplete" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decidePreDrain(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

const baseQueuedCommentFacts: DeferredWakeQueuedCommentFacts = {
  hasQueuedCommentIds: false,
  liveNonSelfCommentIdsLength: 0,
  liveCommentIdsDiffer: false,
  containedSelfAuthoredComment: false,
  preservesIndependentContinuation: false,
};

describe("decideQueuedCommentAction", () => {
  const cases: Array<{
    name: string;
    facts: DeferredWakeQueuedCommentFacts;
    expected: ReturnType<typeof decideQueuedCommentAction>;
  }> = [
    {
      name: "cancel_empty: all queued comments discarded and no independent continuation",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 0,
        liveCommentIdsDiffer: true,
        containedSelfAuthoredComment: false,
        preservesIndependentContinuation: false,
      },
      expected: { kind: "cancel_empty", selfAuthored: false },
    },
    {
      name: "cancel_empty: self-authored comments discarded, error text reflects self-authorship",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 0,
        liveCommentIdsDiffer: true,
        containedSelfAuthoredComment: true,
        preservesIndependentContinuation: false,
      },
      expected: { kind: "cancel_empty", selfAuthored: true },
    },
    {
      name: "normalize: no live comments, but an independent continuation reason still rewrites the queued id list",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 0,
        liveCommentIdsDiffer: true,
        containedSelfAuthoredComment: false,
        preservesIndependentContinuation: true,
      },
      expected: { kind: "normalize" },
    },
    {
      name: "proceed: an independent continuation reason keeps the wake alive with the live id set already matching",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 0,
        liveCommentIdsDiffer: false,
        containedSelfAuthoredComment: false,
        preservesIndependentContinuation: true,
      },
      expected: { kind: "proceed" },
    },
    {
      name: "normalize: the live comment id set differs from the queued set",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 1,
        liveCommentIdsDiffer: true,
        containedSelfAuthoredComment: false,
        preservesIndependentContinuation: false,
      },
      expected: { kind: "normalize" },
    },
    {
      name: "proceed: no queued comments",
      facts: baseQueuedCommentFacts,
      expected: { kind: "proceed" },
    },
    {
      name: "proceed: queued comments are all still live, matching the queued set",
      facts: {
        ...baseQueuedCommentFacts,
        hasQueuedCommentIds: true,
        liveNonSelfCommentIdsLength: 1,
        liveCommentIdsDiffer: false,
      },
      expected: { kind: "proceed" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideQueuedCommentAction(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

const baseWakeOutcomeFacts: DeferredWakeOutcomeFacts = {
  agent: { agentFound: true, invokable: true },
  pauseHold: { activePauseHold: false, treeHoldInteractionWake: false },
};

describe("decideWakeOutcome", () => {
  const cases: Array<{
    name: string;
    facts: DeferredWakeOutcomeFacts;
    expected: ReturnType<typeof decideWakeOutcome>;
  }> = [
    {
      name: "fail_not_invokable: the agent lookup returns not-found",
      facts: { ...baseWakeOutcomeFacts, agent: { agentFound: false, invokable: false } },
      expected: { kind: "fail_not_invokable" },
    },
    {
      name: "fail_not_invokable: the agent is found but not invokable",
      facts: { ...baseWakeOutcomeFacts, agent: { agentFound: true, invokable: false } },
      expected: { kind: "fail_not_invokable" },
    },
    {
      name: "cancel_pause_hold: an active pause hold with no verified tree-hold interaction",
      facts: { ...baseWakeOutcomeFacts, pauseHold: { activePauseHold: true, treeHoldInteractionWake: false } },
      expected: { kind: "cancel_pause_hold" },
    },
    {
      name: "promote: an active pause hold but a verified tree-hold interaction wake survives it",
      facts: { ...baseWakeOutcomeFacts, pauseHold: { activePauseHold: true, treeHoldInteractionWake: true } },
      expected: { kind: "promote" },
    },
    {
      name: "promote: an invokable agent and no pause hold",
      facts: baseWakeOutcomeFacts,
      expected: { kind: "promote" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideWakeOutcome(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

const baseReleaseRecoveryFacts: ReleaseRecoveryFacts = {
  suppressImmediateRecovery: false,
  reviewParticipant: {
    applies: false,
    isExecutionReviewParticipantRecoveryRun: false,
  },
  immediate: {
    applies: false,
    isDispositionRepairRetry: false,
    hasExplicitBlockerPath: false,
    isWorkspaceValidationFailedRun: false,
    isConfigurationIncompleteFailedRun: false,
    automaticRecoveryAlreadyFailed: false,
  },
  shared: {
    hasExistingExecutionPath: false,
    hasPersistedMonitor: false,
    suppressedByPauseHold: false,
    isStrandedRecoveryOrigin: false,
    recoveryAgentPresent: true,
    recoveryAgentInvokable: true,
  },
};

describe("decideReleaseRecovery", () => {
  const cases: Array<{
    name: string;
    facts: ReleaseRecoveryFacts;
    expected: ReturnType<typeof decideReleaseRecovery>;
  }> = [
    {
      name: "released: neither the review-participant nor the immediate-recovery branch applies",
      facts: baseReleaseRecoveryFacts,
      expected: { kind: "released" },
    },
    {
      name: "released: immediate recovery applies but the caller asked to suppress it",
      facts: {
        ...baseReleaseRecoveryFacts,
        suppressImmediateRecovery: true,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
      },
      expected: { kind: "released" },
    },
    {
      name: "released: immediate recovery applies but an existing execution path already covers it",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, hasExistingExecutionPath: true },
      },
      expected: { kind: "released" },
    },
    {
      name: "released: immediate recovery applies but the finishing run carried the disposition-repair retry reason",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          isDispositionRepairRetry: true,
        },
      },
      expected: { kind: "released" },
    },
    {
      name: "released: immediate recovery applies but an explicit blocker path exists",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          hasExplicitBlockerPath: true,
        },
      },
      expected: { kind: "released" },
    },
    {
      name: "blocked_recovery_in_place: immediate recovery applies on a stranded-issue-recovery origin",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, isStrandedRecoveryOrigin: true },
      },
      expected: { kind: "blocked_recovery_in_place" },
    },
    {
      name: "blocked: immediate recovery applies but the recovery agent is not invokable",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, recoveryAgentInvokable: false },
      },
      expected: { kind: "blocked", notice: "immediate_execution_path" },
    },
    {
      name: "blocked: immediate recovery applies and the run failed workspace validation",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          isWorkspaceValidationFailedRun: true,
        },
      },
      expected: { kind: "blocked", notice: "workspace_validation" },
    },
    {
      name: "blocked: immediate recovery applies and the run failed on incomplete configuration",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: {
          ...baseReleaseRecoveryFacts.immediate,
          applies: true,
          isConfigurationIncompleteFailedRun: true,
        },
      },
      expected: { kind: "blocked", notice: "configuration_incomplete" },
    },
    {
      name: "queue_recovery: immediate recovery applies and no suppression or block condition fires",
      facts: {
        ...baseReleaseRecoveryFacts,
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true },
      },
      expected: { kind: "queue_recovery" },
    },
    {
      name: "released: review-participant recovery applies but a persisted monitor already covers it",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: { ...baseReleaseRecoveryFacts.reviewParticipant, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, hasPersistedMonitor: true },
      },
      expected: { kind: "released" },
    },
    {
      name: "blocked_recovery_in_place: review-participant recovery applies on a stranded-issue-recovery origin",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: { ...baseReleaseRecoveryFacts.reviewParticipant, applies: true },
        shared: { ...baseReleaseRecoveryFacts.shared, isStrandedRecoveryOrigin: true },
      },
      expected: { kind: "blocked_recovery_in_place" },
    },
    {
      name: "blocked: review-participant recovery applies but the finishing run was itself that recovery retry",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: {
          ...baseReleaseRecoveryFacts.reviewParticipant,
          applies: true,
          isExecutionReviewParticipantRecoveryRun: true,
        },
      },
      expected: { kind: "blocked", notice: "execution_review_participant" },
    },
    {
      name: "queue_review_participant_recovery: review-participant recovery applies and no suppression or block condition fires",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: { ...baseReleaseRecoveryFacts.reviewParticipant, applies: true },
      },
      expected: { kind: "queue_review_participant_recovery" },
    },
    {
      name: "review-participant recovery is evaluated before immediate recovery when both apply",
      facts: {
        ...baseReleaseRecoveryFacts,
        reviewParticipant: { ...baseReleaseRecoveryFacts.reviewParticipant, applies: true },
        // If the immediate branch were evaluated instead, this flag would force a
        // "blocked" outcome; the expected "queue_review_participant_recovery" here
        // proves the review-participant branch, checked first, decides the outcome.
        immediate: { ...baseReleaseRecoveryFacts.immediate, applies: true, isWorkspaceValidationFailedRun: true },
      },
      expected: { kind: "queue_review_participant_recovery" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideReleaseRecovery(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

describe("deriveImmediateRecoveryContextLabels", () => {
  const cases: Array<{
    name: string;
    issueStatus: string;
    expected: ImmediateRecoveryContextLabels;
  }> = [
    {
      name: "todo: the issue lost its assignment",
      issueStatus: "todo",
      expected: {
        retryReason: "assignment_recovery",
        recoveryReason: "issue_assignment_recovery",
        recoverySource: "issue.assignment_recovery",
      },
    },
    {
      name: "not todo: an in_progress issue is a stalled continuation",
      issueStatus: "in_progress",
      expected: {
        retryReason: "issue_continuation_needed",
        recoveryReason: "issue_continuation_needed",
        recoverySource: "issue.continuation_recovery",
      },
    },
    {
      name: "not todo: any other status also derives the stalled-continuation labels",
      issueStatus: "in_review",
      expected: {
        retryReason: "issue_continuation_needed",
        recoveryReason: "issue_continuation_needed",
        recoverySource: "issue.continuation_recovery",
      },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(deriveImmediateRecoveryContextLabels(testCase.issueStatus)).toEqual(testCase.expected);
    });
  }
});

const baseWakeAdmissionFacts: WakeAdmissionFacts = {
  isSameExecutionAgent: true,
  shouldDeferFollowupWake: false,
  shouldQueueFollowupForRunningWake: false,
  availableActiveExecutionRunPresent: true,
};

describe("decideWakeAdmission", () => {
  const cases: Array<{
    name: string;
    facts: WakeAdmissionFacts;
    expected: ReturnType<typeof decideWakeAdmission>;
  }> = [
    {
      name: "coalesce: same execution agent, no defer condition, and a live coalesce target",
      facts: baseWakeAdmissionFacts,
      expected: { kind: "coalesce" },
    },
    {
      name: "defer: same execution agent, but the running agent needs a fresh session",
      facts: { ...baseWakeAdmissionFacts, shouldDeferFollowupWake: true },
      expected: { kind: "defer" },
    },
    {
      name: "defer: same execution agent, but the running turn must finish first",
      facts: { ...baseWakeAdmissionFacts, shouldQueueFollowupForRunningWake: true },
      expected: { kind: "defer" },
    },
    {
      name: "defer: a different agent already holds the execution lock",
      facts: { ...baseWakeAdmissionFacts, isSameExecutionAgent: false },
      expected: { kind: "defer" },
    },
    {
      name: "proceed: the zombie-run filter leaves no live coalesce target",
      facts: { ...baseWakeAdmissionFacts, availableActiveExecutionRunPresent: false },
      expected: { kind: "proceed" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideWakeAdmission(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

describe("decideQueuedCommentWakeLookup", () => {
  const baseFacts: QueuedCommentWakeLookupFacts = {
    wakePresent: true,
    wakeIssueIdMatches: true,
    hasQueuedCommentIds: true,
    wakeStatus: "deferred_issue_execution",
    wakeHasRunId: false,
  };

  const cases: Array<{
    name: string;
    facts: QueuedCommentWakeLookupFacts;
    expected: ReturnType<typeof decideQueuedCommentWakeLookup>;
  }> = [
    {
      name: "not_pending: no wake row was found",
      facts: { ...baseFacts, wakePresent: false },
      expected: { kind: "not_pending" },
    },
    {
      name: "not_pending: the wake's payload names a different issue",
      facts: { ...baseFacts, wakeIssueIdMatches: false },
      expected: { kind: "not_pending" },
    },
    {
      name: "not_pending: the wake's payload carries no queued comment ids",
      facts: { ...baseFacts, hasQueuedCommentIds: false },
      expected: { kind: "not_pending" },
    },
    {
      name: "deferred: the wake is still waiting behind an active execution run",
      facts: baseFacts,
      expected: { kind: "deferred" },
    },
    {
      name: "check_queue_run: the wake is queued and carries a linked run id",
      facts: { ...baseFacts, wakeStatus: "queued", wakeHasRunId: true },
      expected: { kind: "check_queue_run" },
    },
    {
      name: "not_pending: the wake is queued but carries no linked run id",
      facts: { ...baseFacts, wakeStatus: "queued", wakeHasRunId: false },
      expected: { kind: "not_pending" },
    },
    {
      name: "already_dispatching: the wake was claimed",
      facts: { ...baseFacts, wakeStatus: "claimed" },
      expected: { kind: "already_dispatching" },
    },
    {
      name: "already_dispatching: the wake is running",
      facts: { ...baseFacts, wakeStatus: "running" },
      expected: { kind: "already_dispatching" },
    },
    {
      name: "already_dispatching: the wake succeeded and still carries a run id",
      facts: { ...baseFacts, wakeStatus: "succeeded", wakeHasRunId: true },
      expected: { kind: "already_dispatching" },
    },
    {
      name: "already_dispatching: the wake failed and still carries a run id",
      facts: { ...baseFacts, wakeStatus: "failed", wakeHasRunId: true },
      expected: { kind: "already_dispatching" },
    },
    {
      name: "not_pending: the wake succeeded but carries no run id",
      facts: { ...baseFacts, wakeStatus: "succeeded", wakeHasRunId: false },
      expected: { kind: "not_pending" },
    },
    {
      name: "not_pending: the wake was cancelled",
      facts: { ...baseFacts, wakeStatus: "cancelled" },
      expected: { kind: "not_pending" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideQueuedCommentWakeLookup(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

describe("decideQueuedCommentReorder", () => {
  const cases: Array<{
    name: string;
    facts: QueuedCommentReorderFacts;
    expected: ReturnType<typeof decideQueuedCommentReorder>;
  }> = [
    {
      name: "ok: the submitted order is a permutation of the current ids",
      facts: { currentIds: ["a", "b", "c"], orderedIds: ["c", "a", "b"] },
      expected: { kind: "ok" },
    },
    {
      name: "mismatch: the submitted order carries a duplicate id",
      facts: { currentIds: ["a", "b"], orderedIds: ["a", "a"] },
      expected: { kind: "mismatch" },
    },
    {
      name: "mismatch: the submitted order drops an id",
      facts: { currentIds: ["a", "b", "c"], orderedIds: ["a", "b"] },
      expected: { kind: "mismatch" },
    },
    {
      name: "mismatch: the submitted order adds an id the queue does not have",
      facts: { currentIds: ["a", "b"], orderedIds: ["a", "b", "c"] },
      expected: { kind: "mismatch" },
    },
    {
      name: "mismatch: the submitted order names an id the current queue does not have",
      facts: { currentIds: ["a", "b"], orderedIds: ["a", "c"] },
      expected: { kind: "mismatch" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideQueuedCommentReorder(testCase.facts)).toEqual(testCase.expected);
    });
  }
});

describe("decideQueuedCommentActorOwnsEntry", () => {
  const cases: Array<{
    name: string;
    facts: QueuedCommentActorOwnershipFacts;
    expected: boolean;
  }> = [
    {
      name: "owns: a user actor authored the comment",
      facts: { actorType: "user", actorId: "user-1", actorAgentId: null, authorAgentId: null, authorUserId: "user-1" },
      expected: true,
    },
    {
      name: "does not own: a user actor did not author the comment",
      facts: { actorType: "user", actorId: "user-1", actorAgentId: null, authorAgentId: null, authorUserId: "user-2" },
      expected: false,
    },
    {
      name: "owns: an agent actor authored the comment as that agent",
      facts: { actorType: "agent", actorId: "agent-1", actorAgentId: "agent-1", authorAgentId: "agent-1", authorUserId: null },
      expected: true,
    },
    {
      name: "does not own: an agent actor authored a different comment",
      facts: { actorType: "agent", actorId: "agent-1", actorAgentId: "agent-1", authorAgentId: "agent-2", authorUserId: null },
      expected: false,
    },
    {
      name: "does not own: an agent actor with no resolved agent id",
      facts: { actorType: "agent", actorId: "agent-1", actorAgentId: null, authorAgentId: null, authorUserId: null },
      expected: false,
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideQueuedCommentActorOwnsEntry(testCase.facts)).toBe(testCase.expected);
    });
  }
});

describe("decideStrandedWakeFallback", () => {
  const MINUTE = 60_000;
  const baseStrandedFacts: StrandedWakeFallbackFacts = {
    liveExecutionPresent: false,
    activePauseHold: false,
    executionBlocked: false,
    issueTerminal: false,
    hasUndeliveredUserComment: true,
    waitingMs: 5 * MINUTE,
    staleAfterMs: 60 * MINUTE,
    priorAttempts: 0,
    maxAttempts: 5,
  };

  const cases: Array<{
    name: string;
    facts: StrandedWakeFallbackFacts;
    expected: ReturnType<typeof decideStrandedWakeFallback>;
  }> = [
    // The positive class: a stranded wake with an owner-free issue and live
    // queued comments is exactly the case that waited 1.3 days before.
    {
      name: "redispatch: the owning run released the issue and a human comment is still undelivered",
      facts: baseStrandedFacts,
      expected: { kind: "redispatch" },
    },
    {
      name: "wait: a live run still targets this issue",
      facts: { ...baseStrandedFacts, liveExecutionPresent: true },
      expected: { kind: "wait" },
    },
    {
      name: "wait: an active subtree pause hold covers the issue",
      facts: { ...baseStrandedFacts, activePauseHold: true },
      expected: { kind: "wait" },
    },
    {
      name: "wait: a platform execution hold covers the issue",
      facts: { ...baseStrandedFacts, executionBlocked: true },
      expected: { kind: "wait" },
    },
    {
      name: "wait: an execution hold outranks a terminal issue, so the hold stays visible",
      facts: { ...baseStrandedFacts, executionBlocked: true, issueTerminal: true },
      expected: { kind: "wait" },
    },
    {
      name: "retire: the issue is done and nothing is left to deliver",
      facts: { ...baseStrandedFacts, issueTerminal: true, hasUndeliveredUserComment: false },
      expected: { kind: "retire", reason: "issue_terminal" },
    },
    // The safety property, measured on REK-551: a card that is `done` while a
    // human comment is still undelivered must go back through the normal drain,
    // which reopens a closed card for exactly that input. Retiring it here
    // would drop the message.
    {
      name: "redispatch: a done issue with an undelivered human comment returns to the reopen path",
      facts: { ...baseStrandedFacts, issueTerminal: true },
      expected: { kind: "redispatch" },
    },
    {
      name: "retire: nothing undelivered is left to run",
      facts: { ...baseStrandedFacts, hasUndeliveredUserComment: false },
      expected: { kind: "retire", reason: "no_undelivered_comments" },
    },
    {
      name: "retire: the waiting bound is reached while no owner explains the wait",
      facts: { ...baseStrandedFacts, waitingMs: 60 * MINUTE },
      expected: { kind: "retire", reason: "attempt_budget_exhausted" },
    },
    {
      name: "retire: one second before the bound still redispatches",
      facts: { ...baseStrandedFacts, waitingMs: 60 * MINUTE - 1 },
      expected: { kind: "redispatch" },
    },
    {
      name: "retire: the attempt budget is exhausted before the waiting bound",
      facts: { ...baseStrandedFacts, priorAttempts: 5 },
      expected: { kind: "retire", reason: "attempt_budget_exhausted" },
    },
    {
      name: "retire: an attempt short of the budget still redispatches",
      facts: { ...baseStrandedFacts, priorAttempts: 4 },
      expected: { kind: "redispatch" },
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideStrandedWakeFallback(testCase.facts)).toEqual(testCase.expected);
    });
  }

  // AC3, measured as a negative control: a wake that has waited past the bound
  // must not be left in the state the defect produced. Before this rule the row
  // stayed `deferred_issue_execution` and the sweep re-selected it forever.
  it("a wake past the waiting bound never returns a state that re-selects it", () => {
    for (const waitingMs of [0, MINUTE, 60 * MINUTE, 31 * 24 * 60 * MINUTE]) {
      expect(decideStrandedWakeFallback({ ...baseStrandedFacts, waitingMs })).not.toEqual({ kind: "wait" });
    }
  });

  // Every retire branch must name its reason: an unnamed retirement is the
  // unreadable end state this fix exists to remove.
  it("every retire outcome carries the reason that closed it", () => {
    const retired = [
      decideStrandedWakeFallback({ ...baseStrandedFacts, issueTerminal: true, hasUndeliveredUserComment: false }),
      decideStrandedWakeFallback({ ...baseStrandedFacts, hasUndeliveredUserComment: false }),
      decideStrandedWakeFallback({ ...baseStrandedFacts, waitingMs: 60 * MINUTE }),
    ];
    expect(retired.every((decision) => decision.kind === "retire")).toBe(true);
    expect(retired.map((decision) => (decision.kind === "retire" ? decision.reason : null))).toEqual([
      "issue_terminal",
      "no_undelivered_comments",
      "attempt_budget_exhausted",
    ]);
  });

  // AC3 as a safety property: a wake that still owes a human message is never
  // retired for a reason that does not say so. Only the budget may close it, and
  // the caller hands the comment to the delivery path before that happens.
  it("never retires an undelivered human comment without naming the budget", () => {
    const holdingComment: StrandedWakeFallbackFacts = { ...baseStrandedFacts, hasUndeliveredUserComment: true };
    for (const facts of [
      { ...holdingComment },
      { ...holdingComment, issueTerminal: true },
      { ...holdingComment, activePauseHold: true },
      { ...holdingComment, executionBlocked: true },
    ]) {
      expect(decideStrandedWakeFallback(facts)).not.toEqual({ kind: "retire", reason: "issue_terminal" });
      expect(decideStrandedWakeFallback(facts)).not.toEqual({ kind: "retire", reason: "no_undelivered_comments" });
    }
    // Only the bound, and only once it is actually reached, may close it.
    expect(decideStrandedWakeFallback(holdingComment)).toEqual({ kind: "redispatch" });
    expect(decideStrandedWakeFallback({ ...holdingComment, waitingMs: 60 * MINUTE }))
      .toEqual({ kind: "retire", reason: "attempt_budget_exhausted" });
  });
});
