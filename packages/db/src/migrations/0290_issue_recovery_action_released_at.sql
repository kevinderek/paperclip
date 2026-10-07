-- A settled no-replay disposition used to keep its own hold alive forever.
-- executionBlockerPredicate read evidence->automaticRecovery->>replay without
-- any release marker, so a resolved row still matched on every wake: the card
-- accepted todo, the dispatch gate cancelled the queued run as stale, and the
-- interrupted run's sweep put it straight back on blocked. released_at is where
-- the hold ends; the evidence stays readable as a signal.
ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone;

-- Rows the automatic sweep settled before this column existed were written
-- without a release marker. Backfill exactly the set the fixed settle releases,
-- so the cards parked on this hold today become workable on deploy.
--
-- The exception is the whole workspace-restore class, not just the unsafe
-- archive: the settle keeps released_at null whenever the run recorded any
-- WORKSPACE_RESTORE_FAILURE_CODES value (execution-recovery-resolution.ts), and
-- continuing such a run demands recorded workspaceRepairEvidence
-- (claimRecoveryReceipt). None of the four is repairable by a provider turn, so
-- none of them may be released here. Naming one of the four would release a hold
-- the new sweep is built to keep - measured 07-10 against the settle itself.
UPDATE "issue_recovery_actions"
SET "released_at" = coalesce("resolved_at", "updated_at", "created_at", now())
WHERE "released_at" IS NULL
  AND "status" = 'resolved'
  AND "outcome" IN ('blocked', 'cancelled')
  AND "evidence"->'automaticRecovery'->>'replay' = 'blocked'
  AND coalesce("evidence"->>'workspaceRestoreFailure', '') NOT IN (
    'restore_permission_denied',
    'restore_lock_timeout',
    'restore_unsafe_archive',
    'restore_failed'
  );
