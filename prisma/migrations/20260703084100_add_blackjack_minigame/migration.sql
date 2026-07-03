-- CreateTable
CREATE TABLE "MinigamePlayLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "gameType" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "playDate" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "MinigamePlayLog_userId_gameType_playDate_key" ON "MinigamePlayLog"("userId", "gameType", "playDate");
