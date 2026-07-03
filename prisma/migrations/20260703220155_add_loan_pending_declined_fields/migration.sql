-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Loan" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lenderId" TEXT NOT NULL,
    "borrowerId" TEXT NOT NULL,
    "principal" INTEGER NOT NULL,
    "dueDays" INTEGER,
    "dueAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repaidAt" DATETIME,
    "voidedAt" DATETIME
);
INSERT INTO "new_Loan" ("borrowerId", "createdAt", "dueAt", "id", "lenderId", "principal", "repaidAt", "status", "voidedAt") SELECT "borrowerId", "createdAt", "dueAt", "id", "lenderId", "principal", "repaidAt", "status", "voidedAt" FROM "Loan";
DROP TABLE "Loan";
ALTER TABLE "new_Loan" RENAME TO "Loan";
CREATE INDEX "Loan_borrowerId_idx" ON "Loan"("borrowerId");
CREATE INDEX "Loan_lenderId_idx" ON "Loan"("lenderId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
