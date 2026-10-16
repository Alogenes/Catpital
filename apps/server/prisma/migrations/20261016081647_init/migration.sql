-- CreateEnum
CREATE TYPE "MarketKind" AS ENUM ('STOCK', 'CRYPTO');

-- CreateEnum
CREATE TYPE "MarketDataSource" AS ENUM ('PROCEDURAL', 'LIVE_API');

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('ACTIVE', 'HALTED', 'DELISTED');

-- CreateEnum
CREATE TYPE "PositionSide" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED', 'LIQUIDATED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'FILLED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('USER', 'TAKE_PROFIT', 'STOP_LOSS', 'LIQUIDATION');

-- CreateEnum
CREATE TYPE "Liquidity" AS ENUM ('MAKER', 'TAKER');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('INITIAL_GRANT', 'EXTERNAL_DEPOSIT', 'EXTERNAL_WITHDRAW', 'MARGIN_LOCK', 'MARGIN_ADD', 'MARGIN_RELEASE', 'REALIZED_PNL', 'TRADING_FEE', 'LIQUIDATION_DEFICIT', 'ORDER_LOCK', 'ORDER_UNLOCK', 'BANKRUPTCY_WRITE_OFF', 'BANKRUPTCY_RELIEF', 'ADMIN_ADJUST');

-- CreateEnum
CREATE TYPE "LifeStatus" AS ENUM ('ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('ADMIN_COMMAND', 'JSON_SEED', 'DASHBOARD');

-- CreateEnum
CREATE TYPE "CandleInterval" AS ENUM ('M1', 'M5', 'M15', 'H1', 'D1');

-- CreateEnum
CREATE TYPE "LeaderboardPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "LeaderboardBoard" AS ENUM ('RETURN_PCT', 'NET_WORTH');

-- CreateEnum
CREATE TYPE "BroadcastKind" AS ENUM ('BIG_WIN', 'LIQUIDATION', 'DEFICIT', 'BANKRUPTCY', 'MARKET_EVENT');

-- CreateEnum
CREATE TYPE "TransferDirection" AS ENUM ('DEPOSIT', 'WITHDRAW');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "globalName" TEXT,
    "avatarHash" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "userId" TEXT NOT NULL,
    "balance" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "locked" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "lifeId" TEXT NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amount" DECIMAL(36,8) NOT NULL,
    "balanceAfter" DECIMAL(36,8) NOT NULL,
    "isExternal" BOOLEAN NOT NULL DEFAULT false,
    "marketId" TEXT,
    "positionId" TEXT,
    "orderId" TEXT,
    "idempotencyKey" TEXT,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lives" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" "LifeStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "startingBalance" DECIMAL(36,8) NOT NULL,
    "peakNetWorth" DECIMAL(36,8) NOT NULL,
    "peakNetWorthAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "troughNetWorth" DECIMAL(36,8) NOT NULL,
    "closedTradeCount" INTEGER NOT NULL DEFAULT 0,
    "winCount" INTEGER NOT NULL DEFAULT 0,
    "lossCount" INTEGER NOT NULL DEFAULT 0,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "liquidationCount" INTEGER NOT NULL DEFAULT 0,
    "deficitCount" INTEGER NOT NULL DEFAULT 0,
    "totalVolume" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "totalFeesPaid" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "totalRealizedPnl" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "bestTradeRoe" DECIMAL(36,8),
    "bestTradePnl" DECIMAL(36,8),
    "worstLiquidationLoss" DECIMAL(36,8),
    "worstLiquidationMarketId" TEXT,
    "totalDeficit" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "maxLeverageUsed" DECIMAL(36,8) NOT NULL DEFAULT 1,
    "leverageVolumeSum" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "longVolume" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "shortVolume" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "totalHoldingSeconds" BIGINT NOT NULL DEFAULT 0,
    "danmakuCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "markets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameI18n" JSONB NOT NULL DEFAULT '{}',
    "kind" "MarketKind" NOT NULL,
    "dataSource" "MarketDataSource" NOT NULL DEFAULT 'PROCEDURAL',
    "status" "MarketStatus" NOT NULL DEFAULT 'ACTIVE',
    "adapterKey" TEXT,
    "adapterSymbol" TEXT,
    "tradingHours" JSONB NOT NULL DEFAULT '{"timezone":"UTC","sessions":[]}',
    "tickIntervalMs" INTEGER NOT NULL DEFAULT 1000,
    "tickSize" DECIMAL(36,8) NOT NULL,
    "lotSize" DECIMAL(36,8) NOT NULL,
    "minNotional" DECIMAL(36,8) NOT NULL,
    "maxLeverage" DECIMAL(36,8) NOT NULL DEFAULT 100,
    "maintenanceMarginRate" DECIMAL(36,8) NOT NULL,
    "makerFeeRate" DECIMAL(36,8) NOT NULL,
    "takerFeeRate" DECIMAL(36,8) NOT NULL,
    "liquidationFeeRate" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "initialPrice" DECIMAL(36,8) NOT NULL,
    "lastPrice" DECIMAL(36,8) NOT NULL,
    "lastTickAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_engine_configs" (
    "marketId" TEXT NOT NULL,
    "drift" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "volatility" DECIMAL(36,8) NOT NULL,
    "meanReversionSpeed" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "meanReversionTarget" DECIMAL(36,8),
    "jumpIntensity" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "jumpMean" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "jumpStdDev" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "baseVolume" DECIMAL(36,8) NOT NULL,
    "volumeVolCoupling" DECIMAL(36,8) NOT NULL DEFAULT 1,
    "timeScale" DECIMAL(36,8) NOT NULL DEFAULT 1,
    "priceFloor" DECIMAL(36,8) NOT NULL,
    "driftOverride" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "volMultiplier" DECIMAL(36,8) NOT NULL DEFAULT 1,
    "overrideUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_engine_configs_pkey" PRIMARY KEY ("marketId")
);

-- CreateTable
CREATE TABLE "candles" (
    "marketId" TEXT NOT NULL,
    "interval" "CandleInterval" NOT NULL,
    "openTime" TIMESTAMP(3) NOT NULL,
    "open" DECIMAL(36,8) NOT NULL,
    "high" DECIMAL(36,8) NOT NULL,
    "low" DECIMAL(36,8) NOT NULL,
    "close" DECIMAL(36,8) NOT NULL,
    "volume" DECIMAL(36,8) NOT NULL,
    "tradeCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "candles_pkey" PRIMARY KEY ("marketId","interval","openTime")
);

-- CreateTable
CREATE TABLE "scheduled_events" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "triggerAt" TIMESTAMP(3) NOT NULL,
    "headline" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "i18n" JSONB NOT NULL DEFAULT '{}',
    "gapPercent" DECIMAL(36,8) NOT NULL,
    "driftAdjust" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "volMultiplier" DECIMAL(36,8) NOT NULL DEFAULT 1,
    "durationSec" INTEGER NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'PENDING',
    "source" "EventSource" NOT NULL,
    "createdById" TEXT,
    "priceBefore" DECIMAL(36,8),
    "priceAfter" DECIMAL(36,8),
    "triggeredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "lifeId" TEXT NOT NULL,
    "openKey" TEXT,
    "side" "PositionSide" NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "quantity" DECIMAL(36,8) NOT NULL,
    "entryPrice" DECIMAL(36,8) NOT NULL,
    "margin" DECIMAL(36,8) NOT NULL,
    "leverage" DECIMAL(36,8) NOT NULL,
    "liquidationPrice" DECIMAL(36,8) NOT NULL,
    "takeProfitPrice" DECIMAL(36,8),
    "stopLossPrice" DECIMAL(36,8),
    "addedMargin" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "feesPaid" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "peakQuantity" DECIMAL(36,8) NOT NULL,
    "exitPrice" DECIMAL(36,8),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "lifeId" TEXT NOT NULL,
    "positionId" TEXT,
    "clientOrderId" TEXT,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL,
    "source" "OrderSource" NOT NULL DEFAULT 'USER',
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "leverage" DECIMAL(36,8) NOT NULL,
    "quantity" DECIMAL(36,8) NOT NULL,
    "limitPrice" DECIMAL(36,8),
    "lockedAmount" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "takeProfitPrice" DECIMAL(36,8),
    "stopLossPrice" DECIMAL(36,8),
    "fillPrice" DECIMAL(36,8),
    "closedQuantity" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "openedQuantity" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "liquidity" "Liquidity",
    "feeRate" DECIMAL(36,8),
    "fee" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "realizedPnl" DECIMAL(36,8),
    "realizedRoe" DECIMAL(36,8),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filledAt" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidations" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "lifeId" TEXT NOT NULL,
    "side" "PositionSide" NOT NULL,
    "quantity" DECIMAL(36,8) NOT NULL,
    "entryPrice" DECIMAL(36,8) NOT NULL,
    "margin" DECIMAL(36,8) NOT NULL,
    "leverage" DECIMAL(36,8) NOT NULL,
    "liquidationPrice" DECIMAL(36,8) NOT NULL,
    "executionPrice" DECIMAL(36,8) NOT NULL,
    "realizedPnl" DECIMAL(36,8) NOT NULL,
    "fee" DECIMAL(36,8) NOT NULL,
    "settlement" DECIMAL(36,8) NOT NULL,
    "deficit" DECIMAL(36,8) NOT NULL,
    "totalLoss" DECIMAL(36,8) NOT NULL,
    "balanceBefore" DECIMAL(36,8) NOT NULL,
    "balanceAfter" DECIMAL(36,8) NOT NULL,
    "scheduledEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "liquidations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bankruptcy_resumes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lifeId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "survivedSeconds" BIGINT NOT NULL,
    "startingBalance" DECIMAL(36,8) NOT NULL,
    "peakNetWorth" DECIMAL(36,8) NOT NULL,
    "finalBalance" DECIMAL(36,8) NOT NULL,
    "debtWrittenOff" DECIMAL(36,8) NOT NULL,
    "reliefGranted" DECIMAL(36,8) NOT NULL,
    "bestTradeRoe" DECIMAL(36,8),
    "bestTradePnl" DECIMAL(36,8),
    "worstLiquidationLoss" DECIMAL(36,8),
    "totalFeesPaid" DECIMAL(36,8) NOT NULL,
    "totalVolume" DECIMAL(36,8) NOT NULL,
    "winRate" DECIMAL(36,8) NOT NULL,
    "closedTradeCount" INTEGER NOT NULL,
    "liquidationCount" INTEGER NOT NULL,
    "deficitCount" INTEGER NOT NULL,
    "avgLeverage" DECIMAL(36,8) NOT NULL,
    "maxLeverageUsed" DECIMAL(36,8) NOT NULL,
    "titles" TEXT[],
    "stats" JSONB NOT NULL,
    "discordChannelId" TEXT,
    "discordMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bankruptcy_resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_period_stats" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" "LeaderboardPeriod" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "startNetWorth" DECIMAL(36,8) NOT NULL,
    "netExternalFlow" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "weightedExternalFlow" DECIMAL(36,8) NOT NULL DEFAULT 0,
    "endNetWorth" DECIMAL(36,8),
    "returnPct" DECIMAL(36,8),
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "finalizedAt" TIMESTAMP(3),

    CONSTRAINT "leaderboard_period_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leaderboard_snapshots" (
    "id" TEXT NOT NULL,
    "period" "LeaderboardPeriod" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "board" "LeaderboardBoard" NOT NULL,
    "rank" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "value" DECIMAL(36,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leaderboard_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" TEXT NOT NULL,
    "kind" "BroadcastKind" NOT NULL,
    "userId" TEXT,
    "marketId" TEXT,
    "payload" JSONB NOT NULL,
    "discordChannelId" TEXT,
    "discordMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guild_configs" (
    "guildId" TEXT NOT NULL,
    "broadcastChannelId" TEXT,
    "adminRoleIds" TEXT[],
    "locale" TEXT NOT NULL DEFAULT 'zh-CN',
    "broadcastToggles" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_configs_pkey" PRIMARY KEY ("guildId")
);

-- CreateTable
CREATE TABLE "api_clients" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "scopes" TEXT[],
    "webhookUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_transfers" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "direction" "TransferDirection" NOT NULL,
    "amount" DECIMAL(36,8) NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "externalRef" TEXT NOT NULL,
    "rejectReason" TEXT,
    "ledgerEntryId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "external_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_nonces" (
    "nonce" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_nonces_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotencyKey_key" ON "ledger_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ledger_entries_userId_createdAt_idx" ON "ledger_entries"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_userId_isExternal_createdAt_idx" ON "ledger_entries"("userId", "isExternal", "createdAt");

-- CreateIndex
CREATE INDEX "ledger_entries_lifeId_idx" ON "ledger_entries"("lifeId");

-- CreateIndex
CREATE INDEX "lives_userId_status_idx" ON "lives"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "lives_userId_generation_key" ON "lives"("userId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "markets_code_key" ON "markets"("code");

-- CreateIndex
CREATE INDEX "candles_marketId_interval_openTime_idx" ON "candles"("marketId", "interval", "openTime" DESC);

-- CreateIndex
CREATE INDEX "scheduled_events_status_triggerAt_idx" ON "scheduled_events"("status", "triggerAt");

-- CreateIndex
CREATE INDEX "scheduled_events_marketId_triggerAt_idx" ON "scheduled_events"("marketId", "triggerAt");

-- CreateIndex
CREATE UNIQUE INDEX "positions_openKey_key" ON "positions"("openKey");

-- CreateIndex
CREATE INDEX "positions_userId_status_idx" ON "positions"("userId", "status");

-- CreateIndex
CREATE INDEX "positions_marketId_status_idx" ON "positions"("marketId", "status");

-- CreateIndex
CREATE INDEX "orders_marketId_status_type_idx" ON "orders"("marketId", "status", "type");

-- CreateIndex
CREATE INDEX "orders_userId_createdAt_idx" ON "orders"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "orders_userId_clientOrderId_key" ON "orders"("userId", "clientOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "liquidations_positionId_key" ON "liquidations"("positionId");

-- CreateIndex
CREATE INDEX "liquidations_userId_createdAt_idx" ON "liquidations"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "liquidations_marketId_createdAt_idx" ON "liquidations"("marketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bankruptcy_resumes_lifeId_key" ON "bankruptcy_resumes"("lifeId");

-- CreateIndex
CREATE INDEX "bankruptcy_resumes_userId_generation_idx" ON "bankruptcy_resumes"("userId", "generation");

-- CreateIndex
CREATE INDEX "leaderboard_period_stats_period_periodKey_idx" ON "leaderboard_period_stats"("period", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_period_stats_userId_period_periodKey_key" ON "leaderboard_period_stats"("userId", "period", "periodKey");

-- CreateIndex
CREATE INDEX "leaderboard_snapshots_userId_idx" ON "leaderboard_snapshots"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "leaderboard_snapshots_period_periodKey_board_rank_key" ON "leaderboard_snapshots"("period", "periodKey", "board", "rank");

-- CreateIndex
CREATE INDEX "broadcasts_createdAt_idx" ON "broadcasts"("createdAt");

-- CreateIndex
CREATE INDEX "external_transfers_userId_createdAt_idx" ON "external_transfers"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "external_transfers_clientId_externalRef_key" ON "external_transfers"("clientId", "externalRef");

-- CreateIndex
CREATE INDEX "webhook_deliveries_deliveredAt_nextRetryAt_idx" ON "webhook_deliveries"("deliveredAt", "nextRetryAt");

-- CreateIndex
CREATE INDEX "api_nonces_createdAt_idx" ON "api_nonces"("createdAt");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_lifeId_fkey" FOREIGN KEY ("lifeId") REFERENCES "lives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lives" ADD CONSTRAINT "lives_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_engine_configs" ADD CONSTRAINT "market_engine_configs_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candles" ADD CONSTRAINT "candles_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_events" ADD CONSTRAINT "scheduled_events_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_events" ADD CONSTRAINT "scheduled_events_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_lifeId_fkey" FOREIGN KEY ("lifeId") REFERENCES "lives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_lifeId_fkey" FOREIGN KEY ("lifeId") REFERENCES "lives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidations" ADD CONSTRAINT "liquidations_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidations" ADD CONSTRAINT "liquidations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidations" ADD CONSTRAINT "liquidations_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bankruptcy_resumes" ADD CONSTRAINT "bankruptcy_resumes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bankruptcy_resumes" ADD CONSTRAINT "bankruptcy_resumes_lifeId_fkey" FOREIGN KEY ("lifeId") REFERENCES "lives"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_period_stats" ADD CONSTRAINT "leaderboard_period_stats_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leaderboard_snapshots" ADD CONSTRAINT "leaderboard_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_transfers" ADD CONSTRAINT "external_transfers_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "api_clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_transfers" ADD CONSTRAINT "external_transfers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "api_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
