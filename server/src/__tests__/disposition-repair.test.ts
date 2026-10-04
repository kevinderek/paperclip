import { describe, expect, it } from "vitest";
import { ISSUE_RECOVERY_ACTION_KINDS } from "@paperclipai/shared";
import { classifyContinuationFailure } from "../services/recovery/service.ts";
import {
  DISPOSITION_REPAIR_BASE_DELAYS_MS,
  DISPOSITION_REPAIR_MAX_ATTEMPTS,
  dispositionRepairDelayMs,
  dispositionRepairEscalationRepeatsRecentNotice,
  dispositionRepairEscalationRepeatsStandingNotice,
  dispositionRepairMaxAttemptsForRun,
  DISPOSITION_REPAIR_NOTICE_COOLDOWN_MS,
} from "../services/recovery/disposition-repair.ts";
import { LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS } from "../services/recovery/legacy-continuation.ts";

const deliberateWaitRun = {
  id: "run-1",
  agentId: "agent-1",
  status: "cancelled" as const,
  error: "Continuation parked",
  errorCode: "issue_continuation_waiting_on_review",
  contextSnapshot: {},
  livenessState: null,
  startedAt: new Date("2026-08-11T00:00:00.000Z"),
  createdAt: new Date("2026-08-11T00:00:00.000Z"),
};

describe("owner-sticky disposition repair", () => {
  it("classifies a deliberate wait without a target into its dedicated bounded lane", () => {
    expect(ISSUE_RECOVERY_ACTION_KINDS).toContain("deliberate_wait_without_target");
    expect(classifyContinuationFailure(deliberateWaitRun)).toEqual({
      kind: "deliberate_wait_without_target",
      maxAttempts: 5,
      baseBackoffMs: 60_000,
      errorCode: "issue_continuation_waiting_on_review",
    });
  });

  it("uses the persisted five-attempt owner-sticky schedule with bounded deterministic jitter", () => {
    const fingerprint = "disposition_repair:v1:example";
    const timings = [1, 2, 3, 4, 5].map((attempt) => dispositionRepairDelayMs(attempt, fingerprint));

    expect(DISPOSITION_REPAIR_MAX_ATTEMPTS).toBe(5);
    expect(DISPOSITION_REPAIR_BASE_DELAYS_MS).toEqual([0, 60_000, 120_000, 240_000, 480_000]);
    expect(timings[0]).toEqual({ baseDelayMs: 0, jitterMs: 0, delayMs: 0 });
    expect(timings[1]?.baseDelayMs).toBe(60_000);
    expect(timings[1]?.jitterMs).toBeGreaterThanOrEqual(0);
    expect(timings[1]?.jitterMs).toBeLessThanOrEqual(6_000);
    expect(timings[2]?.baseDelayMs).toBe(120_000);
    expect(timings[2]?.jitterMs).toBeGreaterThanOrEqual(0);
    expect(timings[2]?.jitterMs).toBeLessThanOrEqual(12_000);
    expect(timings[3]?.baseDelayMs).toBe(240_000);
    expect(timings[3]?.jitterMs).toBeLessThanOrEqual(24_000);
    expect(timings[4]?.baseDelayMs).toBe(480_000);
    expect(timings[4]?.jitterMs).toBeLessThanOrEqual(48_000);
    expect(dispositionRepairDelayMs(2, fingerprint)).toEqual(timings[1]);
    expect(() => dispositionRepairDelayMs(6, fingerprint)).toThrow(/Invalid disposition repair attempt/);
  });
});

// Measured 2026-10-04 in the activity window 08:48:36Z -> 11:20:22Z
// (GET /api/companies/{id}/activity?limit=5000, 500 rows). Eight
// `issue.disposition_repair_escalated` rows over four source issues: REK-421,
// REK-416, REK-428 and REK-496. Every pair of a source issue carries one
// `sourceStateFingerprint` and two different `episodeFingerprint`s. That is
// the fingerprint that rotates per repair run, and it was the field the
// recovery-action identity was compared on.
const MEASURED_SOURCE_STATE_FINGERPRINT =
  "disposition_repair:v1:4e6401fedda4";
const MEASURED_EPISODE_FINGERPRINT_REK_428_FIRST = "legacy_disposition:v1:a52987616eee";
const MEASURED_EPISODE_FINGERPRINT_REK_428_SECOND = "legacy_disposition:v1:088422ee590c";

describe("one escalation per disposition-repair episode", () => {
  const standingEscalation = {
    activeKind: "deliberate_wait_without_target",
    activeOwnerType: "board",
    issueStatus: "blocked",
    activeEvidence: {
      sourceIssueId: "7a6ad3fb-fbcc-426c-b725-fdfb5de0aded",
      sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
      episodeFingerprint: MEASURED_EPISODE_FINGERPRINT_REK_428_FIRST,
      terminalReason: "unchanged_source_state_exhausted",
      sourceAttemptCount: 2,
      sourceMaxAttempts: 2,
    },
  } as const;

  it("suppresses the second notice for an unchanged source state, whatever the episode fingerprint is", () => {
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        ...standingEscalation,
        sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
        terminalReason: "unchanged_source_state_exhausted",
      }),
    ).toBe(true);
    // The episode fingerprint is deliberately absent from the predicate: it is
    // not part of the call, and the notice is suppressed anyway because the
    // durable source state and the terminal reason are both identical.
    expect(MEASURED_EPISODE_FINGERPRINT_REK_428_FIRST).not.toBe(
      MEASURED_EPISODE_FINGERPRINT_REK_428_SECOND,
    );
  });

  it("notifies again once the board resolved the standing escalation", () => {
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        activeKind: null,
        activeOwnerType: null,
        activeEvidence: null,
        issueStatus: "blocked",
        sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
        terminalReason: "unchanged_source_state_exhausted",
      }),
    ).toBe(false);
  });

  it("notifies again when the durable source state actually changed", () => {
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        ...standingEscalation,
        sourceStateFingerprint: "disposition_repair:v1:e3a1c971137a",
        terminalReason: "unchanged_source_state_exhausted",
      }),
    ).toBe(false);
  });

  it("notifies again when the terminal reason differs", () => {
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        ...standingEscalation,
        sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
        terminalReason: "owner_not_invokable",
      }),
    ).toBe(false);
  });

  it("still re-blocks a source issue that no longer carries the escalation", () => {
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        ...standingEscalation,
        issueStatus: "in_progress",
        sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
        terminalReason: "unchanged_source_state_exhausted",
      }),
    ).toBe(false);
  });

  it("does not suppress a notice while the active action is still agent-owned", () => {
    // An agent-owned action has not reached the board yet, so the sweep that
    // hands it over must still post the notice.
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        ...standingEscalation,
        activeOwnerType: "agent",
        sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
        terminalReason: "unchanged_source_state_exhausted",
      }),
    ).toBe(false);
  });

  it("does not throw on an active action whose evidence is absent", () => {
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        activeKind: "deliberate_wait_without_target",
        activeOwnerType: "board",
        activeEvidence: null,
        issueStatus: "blocked",
        sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
        terminalReason: "unchanged_source_state_exhausted",
      }),
    ).toBe(false);
  });

  it("does not suppress a notice for another recovery kind on the same issue", () => {
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        ...standingEscalation,
        activeKind: "stranded_assigned_issue",
        sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
        terminalReason: "unchanged_source_state_exhausted",
      }),
    ).toBe(false);
  });
});

describe("a succeeded run is measured against the regular spine, not the legacy park spine", () => {
  it("keeps the legacy ceiling of 2 for a run that did not succeed", () => {
    expect(LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS).toBe(2);
    expect(
      dispositionRepairMaxAttemptsForRun({
        legacyMaxAttempts: LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS,
        runSucceeded: false,
      }),
    ).toBe(2);
  });

  it("widens the ceiling to the regular owner-sticky spine of 5 for a succeeded run", () => {
    expect(
      dispositionRepairMaxAttemptsForRun({
        legacyMaxAttempts: LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS,
        runSucceeded: true,
      }),
    ).toBe(DISPOSITION_REPAIR_MAX_ATTEMPTS);
    expect(DISPOSITION_REPAIR_MAX_ATTEMPTS).toBe(5);
  });

  it("never grants less than one attempt", () => {
    expect(
      dispositionRepairMaxAttemptsForRun({ legacyMaxAttempts: 0, runSucceeded: false }),
    ).toBe(1);
    expect(
      dispositionRepairMaxAttemptsForRun({ legacyMaxAttempts: null, runSucceeded: false }),
    ).toBe(LEGACY_DISPOSITION_REPAIR_MAX_ATTEMPTS);
  });
});

describe("a cleared escalation does not re-notify the board inside the cooldown", () => {
  const MEASURED_REASON = "unchanged_source_state_exhausted";

  // Measured 2026-10-04 from `issue.disposition_repair_escalated` and
  // `issue.recovery_action_resolved` rows. REK-416: notice 09:45:07.419Z, the
  // board moved the source issue blocked -> todo at 09:47:32.191Z, which
  // cancelled the action as `source_revalidation` ("stale because the source
  // issue was manually moved from blocked to todo"), and the next sweep
  // escalated again at 09:48:14.245Z — 2m07s after the notice, 42s after the
  // board's own move. Nothing about the failing agent changed in between.
  const rek416Notice = "2026-10-04T09:45:07.419Z";
  const rek416Repeat = "2026-10-04T09:48:14.245Z";

  it("suppresses the notice when the action record was cleared after the notice", () => {
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          {
            terminalReason: MEASURED_REASON,
            sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
            escalatedAt: rek416Notice,
          },
        ],
        terminalReason: MEASURED_REASON,
        now: new Date(rek416Repeat),
      }),
    ).toBe(true);
  });

  it("counts the age from the notice, not from the clear that followed it", () => {
    // The same record cancelled 40 minutes after the notice is still inside the
    // hour, and a record cancelled 61 minutes after it is not. The edge itself
    // belongs to the next window: an hour-old notice is exactly old enough.
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          { terminalReason: MEASURED_REASON, escalatedAt: rek416Notice },
        ],
        terminalReason: MEASURED_REASON,
        now: new Date("2026-10-04T10:44:07.419Z"),
      }),
    ).toBe(true);
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          { terminalReason: MEASURED_REASON, escalatedAt: rek416Notice },
        ],
        terminalReason: MEASURED_REASON,
        now: new Date("2026-10-04T10:45:07.419Z"),
      }),
    ).toBe(false);
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          { terminalReason: MEASURED_REASON, escalatedAt: rek416Notice },
        ],
        terminalReason: MEASURED_REASON,
        now: new Date("2026-10-04T10:46:07.419Z"),
      }),
    ).toBe(false);
  });

  it("still suppresses the measured 54m41s repeat, so the window does not sit under an hour", () => {
    // REK-428: notice 10:39:50.737Z, action cancelled 11:33:16.211Z, repeat
    // escalation 11:34:31.956Z. A 30-minute window would let this one through
    // and put the board back at three notices for one stall.
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          {
            terminalReason: MEASURED_REASON,
            escalatedAt: "2026-10-04T10:39:50.737Z",
          },
        ],
        terminalReason: MEASURED_REASON,
        now: new Date("2026-10-04T11:34:31.956Z"),
      }),
    ).toBe(true);
    expect(DISPOSITION_REPAIR_NOTICE_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });

  it("notifies immediately for a different terminal reason on the same issue", () => {
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          { terminalReason: MEASURED_REASON, escalatedAt: rek416Notice },
        ],
        terminalReason: "budget_exhausted",
        now: new Date(rek416Repeat),
      }),
    ).toBe(false);
  });

  it("does not suppress records written before notices were timestamped", () => {
    // Rows escalated by the previous code carry no `escalatedAt`. Treating a
    // missing timestamp as "recent" would mute the board indefinitely, because
    // nothing would ever age out.
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          { terminalReason: MEASURED_REASON },
          null,
          "unchanged_source_state_exhausted",
          { terminalReason: MEASURED_REASON, escalatedAt: "not-a-date" },
        ],
        terminalReason: MEASURED_REASON,
        now: new Date(rek416Repeat),
      }),
    ).toBe(false);
  });

  it("ignores a timestamp in the future instead of suppressing forever", () => {
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          { terminalReason: MEASURED_REASON, escalatedAt: "2026-10-04T13:00:00.000Z" },
        ],
        terminalReason: MEASURED_REASON,
        now: new Date(rek416Repeat),
      }),
    ).toBe(false);
  });

  it("never suppresses when the cooldown is switched off", () => {
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          { terminalReason: MEASURED_REASON, escalatedAt: rek416Notice },
        ],
        terminalReason: MEASURED_REASON,
        now: new Date(rek416Repeat),
        cooldownMs: 0,
      }),
    ).toBe(false);
  });

  it("reads a Date and an epoch stamp as well as an ISO string", () => {
    const at = new Date(rek416Notice);
    for (const escalatedAt of [at, at.getTime(), rek416Notice]) {
      expect(
        dispositionRepairEscalationRepeatsRecentNotice({
          priorEvidences: [{ terminalReason: MEASURED_REASON, escalatedAt }],
          terminalReason: MEASURED_REASON,
          now: new Date(rek416Repeat),
        }),
      ).toBe(true);
    }
  });

  it("covers what the standing-notice guard cannot see", () => {
    // The two guards are complementary and the measured window needs both:
    // guard one needs a standing board-owned action (REK-421's second notice,
    // 3m21s after the first, with nothing in between), guard two needs the
    // record of a notice whose action was cleared afterwards (REK-416,
    // REK-428, REK-496).
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        activeKind: "deliberate_wait_without_target",
        activeOwnerType: "board",
        activeEvidence: {
          sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
          terminalReason: MEASURED_REASON,
        },
        issueStatus: "blocked",
        sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
        terminalReason: MEASURED_REASON,
      }),
    ).toBe(true);
    expect(
      dispositionRepairEscalationRepeatsStandingNotice({
        activeKind: null,
        activeOwnerType: null,
        activeEvidence: null,
        issueStatus: "todo",
        sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
        terminalReason: MEASURED_REASON,
      }),
    ).toBe(false);
    expect(
      dispositionRepairEscalationRepeatsRecentNotice({
        priorEvidences: [
          {
            terminalReason: MEASURED_REASON,
            sourceStateFingerprint: MEASURED_SOURCE_STATE_FINGERPRINT,
            escalatedAt: rek416Notice,
          },
        ],
        terminalReason: MEASURED_REASON,
        now: new Date(rek416Repeat),
      }),
    ).toBe(true);
  });
});
