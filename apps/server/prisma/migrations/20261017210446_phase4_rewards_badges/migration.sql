-- AlterEnum
ALTER TYPE "BroadcastKind" ADD VALUE 'CHAMPION';

-- AlterEnum
ALTER TYPE "LedgerType" ADD VALUE 'LEADERBOARD_REWARD';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "badges" JSONB NOT NULL DEFAULT '[]';
