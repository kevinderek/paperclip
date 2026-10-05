-- A settled no-replay disposition used to keep its own hold alive forever.
-- executionBlockerPredicate read evidence->automaticRecovery->>replay without
-- any release marker, so a resolved row still matched on every wake: the card
-- accepted todo, the dispatch gate cancelled the queued run as stale, and the
-- interrupted run's sweep put it straight back on blocked. released_at is where
-- the hold ends; the evidence stays readable as a signal.
ALTER TABLE "issue_recovery_actions" ADD COLUMN IF NOT EXISTS "released_at" timestamp with time zone;

-- Rows the automatic sweep settled before this column existed were written
-- without a release marker. Backfill exactly the set the fixed settle releases,
-- so the cards parked on this hold today become workable on deploy. An unsafe
-- workspace restore keeps its hold: it is the one disposition no provider turn
-- can clear, and it must survive until repair or reconciliation.
UPDATE "issue_recovery_actions"
SET "released_at" = coalesce("resolved_at", "updated_at", "created_at", now())
WHERE "released_at" IS NULL
  AND "status" = 'resolved'
  AND "outcome" IN ('blocked', 'cancelled')
  AND "evidence"->'automaticRecovery'->>'replay' = 'blocked'
  AND coalesce("evidence"->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive';
