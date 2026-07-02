-- AlterTable
ALTER TABLE "BetEntry" ADD COLUMN "amount" INTEGER;
ALTER TABLE "BetEntry" ADD COLUMN "payout" INTEGER;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Bet" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'LEGACY_MODE1',
    "amount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "winningOptionId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "settledAt" DATETIME
);
INSERT INTO "new_Bet" ("amount", "closedAt", "createdAt", "creatorId", "id", "settledAt", "status", "title", "winningOptionId") SELECT "amount", "closedAt", "createdAt", "creatorId", "id", "settledAt", "status", "title", "winningOptionId" FROM "Bet";
DROP TABLE "Bet";
ALTER TABLE "new_Bet" RENAME TO "Bet";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
