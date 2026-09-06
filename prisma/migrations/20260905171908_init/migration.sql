-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('PLAYING', 'COMPLETE');

-- CreateEnum
CREATE TYPE "ClaimType" AS ENUM ('POOL', 'STEAL');

-- CreateTable
CREATE TABLE "Player" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "xp" INTEGER NOT NULL DEFAULT 0,
    "trophies" INTEGER NOT NULL DEFAULT 0,
    "totalGames" INTEGER NOT NULL DEFAULT 0,
    "totalWins" INTEGER NOT NULL DEFAULT 0,
    "winStreak" INTEGER NOT NULL DEFAULT 0,
    "bestStreak" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Player_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpCode" (
    "id" TEXT NOT NULL,
    "playerId" TEXT,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "game" TEXT NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'PLAYING',
    "roomCode" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "player1Id" TEXT NOT NULL,
    "player2Id" TEXT,
    "winnerId" TEXT,
    "tied" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "type" "ClaimType" NOT NULL,
    "stolenFromPlayerId" TEXT,

    CONSTRAINT "Claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Player_email_key" ON "Player"("email");

-- CreateIndex
CREATE INDEX "Player_trophies_idx" ON "Player"("trophies");

-- CreateIndex
CREATE INDEX "Player_email_idx" ON "Player"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_token_key" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_token_idx" ON "Session"("token");

-- CreateIndex
CREATE INDEX "Session_playerId_idx" ON "Session"("playerId");

-- CreateIndex
CREATE INDEX "OtpCode_email_code_idx" ON "OtpCode"("email", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Match_roomCode_key" ON "Match"("roomCode");

-- CreateIndex
CREATE INDEX "Match_player1Id_idx" ON "Match"("player1Id");

-- CreateIndex
CREATE INDEX "Match_player2Id_idx" ON "Match"("player2Id");

-- CreateIndex
CREATE INDEX "Match_status_idx" ON "Match"("status");

-- CreateIndex
CREATE INDEX "Match_endedAt_idx" ON "Match"("endedAt");

-- CreateIndex
CREATE INDEX "Claim_matchId_idx" ON "Claim"("matchId");

-- CreateIndex
CREATE INDEX "Claim_playerId_idx" ON "Claim"("playerId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpCode" ADD CONSTRAINT "OtpCode_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_player1Id_fkey" FOREIGN KEY ("player1Id") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_player2Id_fkey" FOREIGN KEY ("player2Id") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_winnerId_fkey" FOREIGN KEY ("winnerId") REFERENCES "Player"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Claim" ADD CONSTRAINT "Claim_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
