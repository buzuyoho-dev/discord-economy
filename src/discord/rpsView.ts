// 💡 이 파일은 가위바위보 게임 상태(도전/결과)를 디스코드 임베드로 "그림"으로 바꿔주는
// 역할만 한다. 실제 게임 규칙이나 DB 처리는 전혀 하지 않는다 (blackjackView.ts와 동일한 역할).
import { EmbedBuilder } from 'discord.js';
import {
  BetTooLargeError,
  BetTooSmallError,
  MIN_BET_AMOUNT,
} from '../services/blackjack';
import { InsufficientBalanceError } from '../services/ledger';
import { BotChallengeError, type RpsChoice, type RpsResult, SelfChallengeError } from '../services/rps';
import { InsufficientOpponentBalanceError } from '../services/rpsGame';

const CHOICE_EMOJI: Record<RpsChoice, string> = {
  가위: '✂️',
  바위: '🪨',
  보: '📄',
};

// 💡 아직 상대방이 응답하지 않은 상태. 챌린저가 무엇을 냈는지는 절대 여기 담기지 않는다.
export function buildChallengeEmbed(params: {
  challengerId: string;
  opponentId: string;
  betAmount: number;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('✂️🪨📄 가위바위보 대결 신청')
    .setColor(0x2b6cb0)
    .setDescription(`<@${params.challengerId}>님이 <@${params.opponentId}>님에게 대결을 신청했습니다!`)
    .addFields({ name: '베팅금', value: `${params.betAmount.toLocaleString()}P` })
    .setFooter({ text: '아래 버튼으로 응답하세요 (10분 내 미응답 시 자동 무효 처리)' });
}

// 💡 거절/타임아웃/정산 시점 검증 실패로 무효 처리됐을 때. 이 경우 베팅금 차감 자체가
// 없었거나(거절/타임아웃) 있었더라도 즉시 환불됐으므로(정산 시점 실패는 트랜잭션이 통째로
// 취소되어 애초에 차감되지 않는다), "차감 없음"만 안내하면 된다.
export function buildVoidEmbed(params: {
  challengerId: string;
  opponentId: string;
  betAmount: number;
  reason: 'REJECTED' | 'TIMEOUT' | 'INVALID_BALANCE';
}): EmbedBuilder {
  const reasonText: Record<typeof params.reason, string> = {
    REJECTED: `❌ <@${params.opponentId}>님이 대결을 거절했습니다.`,
    TIMEOUT: '⏱️ 10분 동안 응답이 없어 자동으로 무효 처리되었습니다.',
    INVALID_BALANCE: '⚠️ 잔액이 부족해져서 무효 처리되었습니다.',
  };

  return new EmbedBuilder()
    .setTitle('✂️🪨📄 가위바위보 - 무효 처리')
    .setColor(0xa0aec0)
    .setDescription(`<@${params.challengerId}>님 vs <@${params.opponentId}>님`)
    .addFields(
      { name: '결과', value: reasonText[params.reason] },
      { name: '베팅금', value: `${params.betAmount.toLocaleString()}P (차감 없음)` }
    );
}

const RESULT_TITLE: Record<RpsResult, string> = {
  CHALLENGER_WIN: '챌린저 승리!',
  OPPONENT_WIN: '상대 승리!',
  DRAW: '무승부',
};

// 💡 승부가 결정 났을 때. 이제서야 두 사람의 선택을 전부 공개한다.
export function buildResultEmbed(params: {
  challengerId: string;
  opponentId: string;
  challengerChoice: RpsChoice;
  opponentChoice: RpsChoice;
  betAmount: number;
  result: RpsResult;
  challengerBalanceAfter: number;
  opponentBalanceAfter: number;
}): EmbedBuilder {
  const isDraw = params.result === 'DRAW';

  return new EmbedBuilder()
    .setTitle(`✂️🪨📄 가위바위보 - ${RESULT_TITLE[params.result]}`)
    .setColor(isDraw ? 0xa0aec0 : 0x38a169)
    .addFields(
      {
        name: '챌린저',
        value: `<@${params.challengerId}>: ${CHOICE_EMOJI[params.challengerChoice]} ${params.challengerChoice} (잔액: ${params.challengerBalanceAfter.toLocaleString()}P)`,
      },
      {
        name: '상대',
        value: `<@${params.opponentId}>: ${CHOICE_EMOJI[params.opponentChoice]} ${params.opponentChoice} (잔액: ${params.opponentBalanceAfter.toLocaleString()}P)`,
      },
      {
        name: '베팅금',
        value: isDraw
          ? `${params.betAmount.toLocaleString()}P (무승부 - 전액 환급)`
          : `${params.betAmount.toLocaleString()}P (승자 +95%, 하우스 수수료 5%)`,
      }
    );
}

// 💡 에러 종류에 맞는 한글 안내 문구를 돌려준다. 모르는 에러면 null을 줘서, 호출한 쪽이
// "이건 내가 처리할 수 없는 에러구나"하고 그대로 다시 던지게(throw) 한다.
export function rpsErrorMessage(error: unknown): string | null {
  if (error instanceof BetTooSmallError) {
    return `최소 베팅금은 ${MIN_BET_AMOUNT.toLocaleString()}P입니다.`;
  }
  if (error instanceof BetTooLargeError) {
    return '베팅금은 보유 포인트의 25%를 넘을 수 없습니다.';
  }
  if (error instanceof InsufficientOpponentBalanceError) {
    return '상대 플레이어의 보유 포인트가 부족합니다.';
  }
  if (error instanceof SelfChallengeError) {
    return '자기 자신에게는 도전할 수 없습니다.';
  }
  if (error instanceof BotChallengeError) {
    return '봇에게는 도전할 수 없습니다.';
  }
  if (error instanceof InsufficientBalanceError) {
    return '포인트가 부족합니다.';
  }
  return null;
}
