-- CreateEnum
CREATE TYPE "ExchangeDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "ExchangeStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "currency_exchanges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "ExchangeDirection" NOT NULL,
    "amount" DECIMAL(36,8) NOT NULL,
    "status" "ExchangeStatus" NOT NULL DEFAULT 'PENDING',
    "remoteBalance" DECIMAL(36,8),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "currency_exchanges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "currency_exchanges_status_createdAt_idx" ON "currency_exchanges"("status", "createdAt");

-- CreateIndex
CREATE INDEX "currency_exchanges_userId_createdAt_idx" ON "currency_exchanges"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "currency_exchanges" ADD CONSTRAINT "currency_exchanges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
