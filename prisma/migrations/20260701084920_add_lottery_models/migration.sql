-- CreateTable
CREATE TABLE "LotteryTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "chosenNumber" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "drawDate" DATETIME NOT NULL,
    "purchasedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "LotteryState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "currentJackpot" INTEGER NOT NULL DEFAULT 0
);

-- CreateIndex
CREATE UNIQUE INDEX "LotteryTicket_userId_drawDate_key" ON "LotteryTicket"("userId", "drawDate");
