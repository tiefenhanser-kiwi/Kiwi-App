-- Plan-Gen Arc Block 4b-3 (D-WS9-072) — per-user "last generated plan-options
-- batch" store for the "See Previous Options" surface. One row per user; each
-- successful generation upserts it (overwrite = "generation clears"). Additive,
-- nullable-safe, no FK into the plan graph — cleanly droppable.

-- CreateTable
CREATE TABLE "wizard_last_batches" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wizard_last_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wizard_last_batches_userId_key" ON "wizard_last_batches"("userId");

-- AddForeignKey
ALTER TABLE "wizard_last_batches" ADD CONSTRAINT "wizard_last_batches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
