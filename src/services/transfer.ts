import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { CreditBannedError, isCreditBanned } from './creditBan';
import { assertNotBotTarget } from './discordTargetGuard';
import { applyHouseTransaction } from './house';
import { isSameKstDay } from './kst';
import { applyTransaction, getOrCreateUser } from './ledger';

export const MAX_TRANSFER_AMOUNT = 50_000_000;
const TRANSFER_FEE_RATE = 0.05;

export class InvalidTransferAmountError extends Error {}
export class TransferAmountTooLargeError extends Error {}
export class CannotTransferToSelfError extends Error {}
export class AlreadyTransferredTodayError extends Error {}

export async function transferPoints(params: {
  senderId: string;
  recipientId: string;
  recipientIsBot?: boolean;
  amount: number;
  now?: Date;
}) {
  if (!Number.isInteger(params.amount) || params.amount <= 0) {
    throw new InvalidTransferAmountError('amount must be a positive integer');
  }
  if (params.amount > MAX_TRANSFER_AMOUNT) {
    throw new TransferAmountTooLargeError(
      `amount ${params.amount} exceeds the max transfer amount ${MAX_TRANSFER_AMOUNT}`
    );
  }
  if (params.senderId === params.recipientId) {
    throw new CannotTransferToSelfError(`${params.senderId} cannot transfer to self`);
  }
  // 💡 봇 계정에게는 양도할 수 없다 - getOrCreateUser를 부르기 전에 먼저 걸러내서,
  // 봇 명의의 User row가 아예 생기지 않도록 한다.
  assertNotBotTarget(params.recipientIsBot, params.recipientId);

  const now = params.now ?? new Date();

  if (await isCreditBanned(params.senderId, now)) {
    throw new CreditBannedError(`${params.senderId} is credit banned`);
  }

  await getOrCreateUser(params.senderId);
  await getOrCreateUser(params.recipientId);

  return prisma.$transaction(async (tx) => {
    const lastOutgoingTransfer = await tx.transaction.findFirst({
      where: { userId: params.senderId, type: TransactionType.TRANSFER, amount: { lt: 0 } },
      orderBy: { createdAt: 'desc' },
    });

    if (lastOutgoingTransfer && isSameKstDay(lastOutgoingTransfer.createdAt, now)) {
      throw new AlreadyTransferredTodayError(`${params.senderId} already transferred today (KST)`);
    }

    const fee = Math.floor(params.amount * TRANSFER_FEE_RATE);
    const netAmount = params.amount - fee;

    await applyTransaction(tx, {
      discordId: params.senderId,
      type: TransactionType.TRANSFER,
      amount: -params.amount,
      description: `양도: ${params.recipientId}에게`,
      occurredAt: now,
    });

    await applyTransaction(tx, {
      discordId: params.recipientId,
      type: TransactionType.TRANSFER,
      amount: netAmount,
      description: `양도 수령: ${params.senderId}으로부터`,
      occurredAt: now,
    });

    if (fee > 0) {
      await applyHouseTransaction(tx, {
        type: TransactionType.TRANSFER,
        amount: fee,
        description: `양도 수수료: ${params.senderId} → ${params.recipientId}`,
        occurredAt: now,
      });
    }

    return { fee, netAmount };
  });
}
