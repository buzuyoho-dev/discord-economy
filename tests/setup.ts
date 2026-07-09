import { afterAll, beforeEach } from 'vitest';
import { prisma } from '../src/db/client';

beforeEach(async () => {
  await prisma.minigamePlayLog.deleteMany();
  await prisma.bettingDoubleCoupon.deleteMany();
  await prisma.economyConfig.deleteMany();
  await prisma.lotteryStatusMessage.deleteMany();
  await prisma.lotteryDrawLog.deleteMany();
  await prisma.lotteryTicket.deleteMany();
  await prisma.lotteryState.deleteMany();
  await prisma.loan.deleteMany();
  await prisma.mode2Entry.deleteMany();
  await prisma.mode2Bet.deleteMany();
  await prisma.betEntry.deleteMany();
  await prisma.betOption.deleteMany();
  await prisma.bet.deleteMany();
  await prisma.houseTransaction.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.user.deleteMany();
  await prisma.house.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});
