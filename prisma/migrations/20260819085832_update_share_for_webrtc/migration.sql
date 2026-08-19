/*
  Warnings:

  - You are about to drop the column `storageKey` on the `File` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "File" DROP COLUMN "storageKey";

-- AlterTable
ALTER TABLE "Share" ADD COLUMN     "answer" TEXT,
ADD COLUMN     "offer" TEXT,
ADD COLUMN     "receiverPeerId" TEXT,
ADD COLUMN     "senderPeerId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'waiting';
