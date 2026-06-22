-- CreateTable
CREATE TABLE "Mode2Bet" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sideALabel" TEXT NOT NULL,
    "sideBLabel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "winningSide" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "settledAt" DATETIME
);

-- CreateTable
CREATE TABLE "Mode2Entry" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "betId" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Mode2Entry_betId_fkey" FOREIGN KEY ("betId") REFERENCES "Mode2Bet" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Mode2Entry_betId_idx" ON "Mode2Entry"("betId");

-- CreateIndex
CREATE UNIQUE INDEX "Mode2Entry_betId_userId_key" ON "Mode2Entry"("betId", "userId");
