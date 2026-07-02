-- AlterTable
ALTER TABLE "BetEntry" ADD COLUMN "couponId" TEXT;

-- CreateTable
CREATE TABLE "EconomyConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'SINGLETON',
    "rebateRate" REAL NOT NULL DEFAULT 0.05,
    "lowerTierWeight" REAL NOT NULL DEFAULT 1.5,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BettingDoubleCoupon" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "usedInBetId" INTEGER
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_House" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "lastRebateBalance" INTEGER NOT NULL DEFAULT 0,
    "lastRebateAt" DATETIME
);
INSERT INTO "new_House" ("balance", "id") SELECT "balance", "id" FROM "House";
DROP TABLE "House";
ALTER TABLE "new_House" RENAME TO "House";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "BettingDoubleCoupon_userId_idx" ON "BettingDoubleCoupon"("userId");

-- Seed: House.lastRebateBalance를 배포 시점의 실제 잔고로 초기화한다.
-- 이걸 빠뜨리면 첫 주 실행 시 지금까지 쌓인 하우스 잔고 전체가 "순증가분"으로
-- 잘못 계산되어 예상보다 훨씬 큰 금액이 한 번에 지급된다.
UPDATE "House" SET "lastRebateBalance" = "balance";

-- Seed: EconomyConfig 싱글톤 row를 초기값(rebateRate 5%, lowerTierWeight 1.5배)으로 생성한다.
INSERT INTO "EconomyConfig" ("id", "rebateRate", "lowerTierWeight", "updatedAt")
VALUES ('SINGLETON', 0.05, 1.5, CURRENT_TIMESTAMP);
