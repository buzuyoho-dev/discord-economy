-- CreateTable
CREATE TABLE "LotteryDrawLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "drawDate" DATETIME NOT NULL,
    "winningNumber" INTEGER NOT NULL,
    "ticketCount" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'CRON',
    "drawnAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "LotteryDrawLog_drawDate_idx" ON "LotteryDrawLog"("drawDate");
