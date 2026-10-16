-- AlterEnum
ALTER TYPE "BroadcastKind" ADD VALUE 'WHALE';

-- AlterTable
ALTER TABLE "market_engine_configs" ADD COLUMN     "impactCap" DECIMAL(36,8) NOT NULL DEFAULT 0,
ADD COLUMN     "impactDecaySec" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "impactLiquidity" DECIMAL(36,8) NOT NULL DEFAULT 0,
ADD COLUMN     "impactVolBoost" DECIMAL(36,8) NOT NULL DEFAULT 1;
