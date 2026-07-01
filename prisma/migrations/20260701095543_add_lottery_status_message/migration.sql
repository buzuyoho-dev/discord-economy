-- CreateTable
CREATE TABLE "LotteryStatusMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawDate" DATETIME NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "channelMessageId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LotteryState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "currentJackpot" INTEGER NOT NULL DEFAULT 0,
    "nextRoundNumber" INTEGER NOT NULL DEFAULT 1
);
INSERT INTO "new_LotteryState" ("currentJackpot", "id") SELECT "currentJackpot", "id" FROM "LotteryState";
DROP TABLE "LotteryState";
ALTER TABLE "new_LotteryState" RENAME TO "LotteryState";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "LotteryStatusMessage_drawDate_key" ON "LotteryStatusMessage"("drawDate");
