import { describe, expect, it } from "vitest";
import {
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
} from "./service.js";
import { legacyExecutionNeedsReconciliation } from "../legacy-execution-recovery.js";

describe("classifyAdapterFailureForRecovery", () => {
  it("uses a typed ACP quota reset without needing the provider's original message", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: "2026-07-15T21:30:00.000Z",
        providerQuotaRetryNotBefore: "2026-07-15T21:30:00.000Z",
      },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the existing backoff for a typed ACP quota failure with no reset timestamp", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "provider_quota",
      error: "ACP agent reported a terminal limit failure.",
      resultJson: { errorFamily: "provider_quota" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("classifies the qualifier-less limit wording and parses the 'resets' clock", () => {
    // Current Claude CLI phrasing, as recorded on the run by the adapter.
    const now = new Date("2026-08-28T22:30:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Claude run failed: subtype=success: You've hit your limit · resets 2:30am (UTC)",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-08-29T02:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("routes unavailable engines to a configuration blocker instead of retrying", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_engine_unavailable",
      error: "Node v22.22.2 does not satisfy Codex ACP's Node >=24.11.0 prerequisite.",
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
    expect(classifyContinuationFailure({ errorCode: "adapter_engine_unavailable" } as never))
      .toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy",
      status: "failed",
      errorCode: "adapter_engine_unavailable",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    })).toBe(false);
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });
});

describe("classifyAdapterFailureForRecovery: bare HTTP 429", () => {
  // Measured 2026-10-04: SEO Sophie (c20b2006-1f4a-4daf-8613-f122403290bf) sat
  // at agent status `error` with exactly this errorReason, and two of her issues
  // were escalated to the board 29 s apart (REK-524 10:46:00.506Z, REK-519
  // 10:46:29.332Z), both `stranded_assigned_issue` / `adapter_failed`. The
  // message matches none of the quota prose, so it fell through to the lane that
  // notifies the board on every failed run.
  const SEEN_PROVIDER_MESSAGE =
    'Too Many Requests: {"status":429,"title":"Too Many Requests"}';

  it("reads the provider's bare 429 as a quota condition with bounded backoff, not a board escalation", () => {
    const now = new Date("2026-10-04T10:46:04.627Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: SEEN_PROVIDER_MESSAGE,
      resultJson: null,
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it.each([
    ["HTTP status line", "HTTP/1.1 429 Too Many Requests"],
    ["bare status code", "upstream returned 429"],
    ["status code in a body", 'upstream said {"status": 429, "detail": "slow down"}'],
    ["named status code", 'error: status_code=429'],
    ["rate limit prose", "API rate limit exceeded for this key"],
  ])("classifies a 429 carried as %s", (_label, error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toMatchObject({ kind: "provider_quota" });
  });

  it("still honours a reset timestamp the provider did send", () => {
    const now = new Date("2026-10-04T10:46:04.627Z");
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: SEEN_PROVIDER_MESSAGE,
      resultJson: { retryNotBefore: "2026-10-04T11:16:04.627Z" },
    }, now)).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-10-04T11:16:04.627Z"),
      parsedResetTime: true,
    });
  });

  it("keeps a genuine capacity limit out of the quota lane", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  it("keeps a non-adapter failure out of the quota lane even with a 429 in its text", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Downstream service replied 429 Too Many Requests.",
      resultJson: null,
    })).toBeNull();
  });
});
