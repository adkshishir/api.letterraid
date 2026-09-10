-- Add a host-controlled "start" step: tournaments now sit in a lobby
-- (startedAt null, endsAt null) until the creator starts them, at which
-- point endsAt = now + durationMin.
ALTER TABLE "Tournament" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Tournament" ALTER COLUMN "endsAt" DROP NOT NULL;

-- Backfill: tournaments created before this migration were already running
-- under the old "starts immediately" behavior, so treat them as already
-- started (startedAt = createdAt) rather than stranding them in the lobby.
UPDATE "Tournament" SET "startedAt" = "createdAt" WHERE "startedAt" IS NULL;
