import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { applyTransaction, getOrCreateUser } from './ledger';

export class NotAdminError extends Error {
  constructor(requestedBy: string) {
    super(`${requestedBy} is not the configured admin`);
    this.name = 'NotAdminError';
  }
}

export class InvalidGrantAmountError extends Error {}

export async function grantPoints(params: {
  requestedBy: string;
  adminDiscordId: string | undefined;
  targetId: string;
  amount: number;
  reason: string;
}) {
  if (!params.adminDiscordId || params.requestedBy !== params.adminDiscordId) {
    throw new NotAdminError(params.requestedBy);
  }
  if (!Number.isInteger(params.amount) || params.amount <= 0) {
    throw new InvalidGrantAmountError('amount must be a positive integer');
  }

  await getOrCreateUser(params.targetId);

  return prisma.$transaction((tx) =>
    applyTransaction(tx, {
      discordId: params.targetId,
      type: TransactionType.ADMIN_GRANT,
      amount: params.amount,
      description: params.reason,
    })
  );
}
