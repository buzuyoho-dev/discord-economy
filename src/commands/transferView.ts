import { CreditBannedError } from '../services/creditBan';
import { BotTargetError } from '../services/discordTargetGuard';
import { InsufficientBalanceError } from '../services/ledger';
import {
  AlreadyTransferredTodayError,
  CannotTransferToSelfError,
  InvalidTransferAmountError,
  TransferAmountTooLargeError,
} from '../services/transfer';

export function transferErrorMessage(error: unknown): string | null {
  if (error instanceof InvalidTransferAmountError) {
    return '금액은 1 이상의 정수여야 합니다.';
  }
  if (error instanceof TransferAmountTooLargeError) {
    return '1회 양도 한도(5,000만 포인트)를 초과합니다.';
  }
  if (error instanceof CannotTransferToSelfError) {
    return '본인에게는 양도할 수 없습니다.';
  }
  if (error instanceof BotTargetError) {
    return '봇에게는 양도할 수 없습니다.';
  }
  if (error instanceof AlreadyTransferredTodayError) {
    return '오늘은 이미 양도를 했습니다. 내일 다시 시도해주세요.';
  }
  if (error instanceof CreditBannedError) {
    return '신용불량 상태라 양도를 이용할 수 없습니다.';
  }
  if (error instanceof InsufficientBalanceError) {
    return '포인트가 부족합니다.';
  }
  return null;
}
