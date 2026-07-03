// 💡 이 파일은 가위바위보 게임과 "돈/DB"가 만나는 지점이다. 승패 규칙 자체는 rps.ts가
// 담당하고, 여기서는 "베팅 전 잔액 확인", "수락 순간 베팅금 동시 차감", "정산 지급"만 다룬다.
// 블랙잭(blackjackGame.ts)과 마찬가지로 모든 돈 처리는 prisma.$transaction으로 감싸서,
// 동시에 여러 요청이 와도 중복 차감/누락이 일어나지 않게 한다.

import { TransactionType } from '@prisma/client';
import { prisma } from '../db/client';
import { applyHouseTransaction } from './house';
import { applyTransaction, getOrCreateUser } from './ledger';
import {
  calculateRpsPayout,
  determineRpsResult,
  type RpsChoice,
  type RpsResult,
} from './rps';
import { validateBetAmount } from './blackjack';

// 💡 상대방이 베팅금만큼도 포인트를 갖고 있지 않을 때 나는 에러. 도전 시작 시점과, 수락(정산)
// 시점 두 군데에서 모두 검사한다 (그 사이에 상대방 잔액이 바뀌었을 수 있어서 재검증이 필요하다).
export class InsufficientOpponentBalanceError extends Error {
  constructor(opponentId: string, betAmount: number) {
    super(`opponent ${opponentId} does not have enough balance for bet ${betAmount}`);
    this.name = 'InsufficientOpponentBalanceError';
  }
}

// 💡 "도전을 시작할 수 있는지" 미리 확인만 하는 함수. 아직 아무 돈도 움직이지 않는다
// (베팅금 차감은 상대가 진짜로 수락했을 때만 일어난다 - resolveRpsChallenge가 담당).
// 여기서는 1) 챌린저 본인의 베팅 한도(10만~보유포인트 25%), 2) 상대방이 베팅금만큼
// 갖고 있는지만 확인한다.
export async function startRpsChallenge(params: {
  challengerId: string;
  opponentId: string;
  betAmount: number;
  now?: Date;
}): Promise<{ challengerBalance: number; opponentBalance: number }> {
  const challenger = await getOrCreateUser(params.challengerId);
  const opponent = await getOrCreateUser(params.opponentId);

  validateBetAmount(params.betAmount, challenger.balance);

  if (opponent.balance < params.betAmount) {
    throw new InsufficientOpponentBalanceError(params.opponentId, params.betAmount);
  }

  return { challengerBalance: challenger.balance, opponentBalance: opponent.balance };
}

// 💡 "상대가 실제로 가위/바위/보 버튼을 눌러서 수락한 순간" 호출되는 함수.
// 여기서 딱 한 번에: 1) 두 사람 잔액을 다시 확인하고(시간차 동안 바뀌었을 수 있으므로),
// 2) 베팅금을 양쪽에서 동시에 차감하고, 3) 승패를 정하고, 4) 정산까지 전부 끝낸다.
// 전부 하나의 원자적 트랜잭션 안에서 처리되므로, 중간에 실패하면 아무 것도 반영되지 않는다.
export async function resolveRpsChallenge(params: {
  challengerId: string;
  opponentId: string;
  betAmount: number;
  challengerChoice: RpsChoice;
  opponentChoice: RpsChoice;
  now?: Date;
}): Promise<{ result: RpsResult; challengerBalanceAfter: number; opponentBalanceAfter: number }> {
  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    // 1) 재검증: 도전 시작 이후 시간이 지나는 동안 두 사람의 잔액이 바뀌었을 수 있으므로,
    // 실제로 차감하기 직전에 다시 한번 최신 잔액으로 확인한다.
    const challenger = await tx.user.findUniqueOrThrow({ where: { discordId: params.challengerId } });
    const opponent = await tx.user.findUniqueOrThrow({ where: { discordId: params.opponentId } });

    validateBetAmount(params.betAmount, challenger.balance);
    if (opponent.balance < params.betAmount) {
      throw new InsufficientOpponentBalanceError(params.opponentId, params.betAmount);
    }

    // 2) 베팅금을 양쪽에서 동시에 차감한다 (여기서부터는 "판돈이 걸린" 상태).
    await applyTransaction(tx, {
      discordId: params.challengerId,
      type: TransactionType.RPS_BET,
      amount: -params.betAmount,
      description: '가위바위보 베팅',
      occurredAt: now,
    });
    await applyTransaction(tx, {
      discordId: params.opponentId,
      type: TransactionType.RPS_BET,
      amount: -params.betAmount,
      description: '가위바위보 베팅',
      occurredAt: now,
    });

    const result = determineRpsResult(params.challengerChoice, params.opponentChoice);

    // 3) 무승부면 방금 차감한 베팅금을 그대로 양쪽에 환급한다. 하우스는 아무것도 가져가지 않는다.
    if (result === 'DRAW') {
      const challengerFinal = await applyTransaction(tx, {
        discordId: params.challengerId,
        type: TransactionType.RPS_VOID,
        amount: params.betAmount,
        description: '가위바위보 무승부 환급',
        occurredAt: now,
      });
      const opponentFinal = await applyTransaction(tx, {
        discordId: params.opponentId,
        type: TransactionType.RPS_VOID,
        amount: params.betAmount,
        description: '가위바위보 무승부 환급',
        occurredAt: now,
      });
      return {
        result,
        challengerBalanceAfter: challengerFinal.balance,
        opponentBalanceAfter: opponentFinal.balance,
      };
    }

    // 4) 승부가 났으면: 승자에게 (원금+순수익)을 지급하고, 패자는 이미 차감된 상태 그대로 두고
    // (기록용으로 0원짜리 RPS_LOSE 거래만 남기고), 하우스는 나머지 5% 수수료를 가져간다.
    const { winnerPayout, housePayout } = calculateRpsPayout(params.betAmount);
    const winnerId = result === 'CHALLENGER_WIN' ? params.challengerId : params.opponentId;
    const loserId = result === 'CHALLENGER_WIN' ? params.opponentId : params.challengerId;

    const winnerFinal = await applyTransaction(tx, {
      discordId: winnerId,
      type: TransactionType.RPS_WIN,
      amount: winnerPayout,
      description: '가위바위보 승리 정산',
      occurredAt: now,
    });
    const loserFinal = await applyTransaction(tx, {
      discordId: loserId,
      type: TransactionType.RPS_LOSE,
      amount: 0,
      description: '가위바위보 패배',
      occurredAt: now,
    });
    await applyHouseTransaction(tx, {
      type: TransactionType.TAX,
      amount: housePayout,
      description: '가위바위보 수수료(5%)',
      occurredAt: now,
    });

    return {
      result,
      challengerBalanceAfter: winnerId === params.challengerId ? winnerFinal.balance : loserFinal.balance,
      opponentBalanceAfter: winnerId === params.opponentId ? winnerFinal.balance : loserFinal.balance,
    };
  });
}
