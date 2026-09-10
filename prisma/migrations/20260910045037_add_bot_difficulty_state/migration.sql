-- CreateTable
CREATE TABLE "BotDifficultyState" (
    "tier" TEXT NOT NULL,
    "thinkMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "whiffMultiplier" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "matchesSeen" INTEGER NOT NULL DEFAULT 0,
    "lastHumanShare" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotDifficultyState_pkey" PRIMARY KEY ("tier")
);
