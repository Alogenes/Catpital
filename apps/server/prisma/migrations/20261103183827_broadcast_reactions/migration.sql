-- CreateTable
CREATE TABLE "broadcast_reactions" (
    "broadcastId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcast_reactions_pkey" PRIMARY KEY ("broadcastId","userId")
);

-- CreateIndex
CREATE INDEX "broadcast_reactions_broadcastId_updatedAt_idx" ON "broadcast_reactions"("broadcastId", "updatedAt");

-- AddForeignKey
ALTER TABLE "broadcast_reactions" ADD CONSTRAINT "broadcast_reactions_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_reactions" ADD CONSTRAINT "broadcast_reactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
