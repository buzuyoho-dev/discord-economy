-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EconomyConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'SINGLETON',
    "rebateRate" REAL NOT NULL DEFAULT 0.05,
    "lowerTierWeight" REAL NOT NULL DEFAULT 1.5,
    "houseBalanceCapRatio" REAL NOT NULL DEFAULT 0.4,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_EconomyConfig" ("id", "lowerTierWeight", "rebateRate", "updatedAt") SELECT "id", "lowerTierWeight", "rebateRate", "updatedAt" FROM "EconomyConfig";
DROP TABLE "EconomyConfig";
ALTER TABLE "new_EconomyConfig" RENAME TO "EconomyConfig";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
