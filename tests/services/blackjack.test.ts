import { describe, expect, test } from 'vitest';
import {
  BetTooLargeError,
  BetTooSmallError,
  calculateHandValue,
  calculatePayout,
  type Card,
  createOrderedDeck,
  dealerShouldHit,
  determineOutcome,
  isBust,
  isNaturalBlackjack,
  MAX_BET_RATIO,
  MIN_BET_AMOUNT,
  shuffleDeck,
  validateBetAmount,
} from '../../src/services/blackjack';

function card(rank: Card['rank'], suit: Card['suit'] = '♠'): Card {
  return { rank, suit };
}

describe('calculateHandValue', () => {
  test('숫자 카드는 그대로 더한다', () => {
    expect(calculateHandValue([card('5'), card('7')])).toBe(12);
  });

  test('J/Q/K는 10으로 계산한다', () => {
    expect(calculateHandValue([card('K'), card('9')])).toBe(19);
  });

  test('에이스는 21을 넘지 않으면 11로 계산한다 (소프트)', () => {
    expect(calculateHandValue([card('A'), card('7')])).toBe(18);
  });

  test('에이스를 11로 계산하면 21을 넘을 때는 1로 낮춰서 계산한다', () => {
    // A(11) + 9 + 5 = 25 -> 버스트라 A를 1로 낮춰서 9+5+1=15
    expect(calculateHandValue([card('A'), card('9'), card('5')])).toBe(15);
  });

  test('에이스 2장은 한 장만 11로 계산해 21을 넘지 않게 한다', () => {
    // A+A = 11+11=22 -> 한 장을 1로 낮춰서 11+1=12
    expect(calculateHandValue([card('A'), card('A')])).toBe(12);
  });

  test('에이스+10짜리 카드 2장은 자연블랙잭 값인 21이다', () => {
    expect(calculateHandValue([card('A'), card('K')])).toBe(21);
  });
});

describe('isBust', () => {
  test('21 이하면 버스트가 아니다', () => {
    expect(isBust([card('10'), card('9')])).toBe(false);
  });

  test('21을 넘으면 버스트다', () => {
    expect(isBust([card('10'), card('9'), card('5')])).toBe(true);
  });
});

describe('isNaturalBlackjack', () => {
  test('카드 2장으로 정확히 21이면 자연블랙잭이다', () => {
    expect(isNaturalBlackjack([card('A'), card('Q')])).toBe(true);
  });

  test('카드 3장으로 21이 되면 자연블랙잭이 아니다 (2장일 때만 인정)', () => {
    expect(isNaturalBlackjack([card('7'), card('7'), card('7')])).toBe(false);
  });

  test('카드 2장이어도 21이 아니면 자연블랙잭이 아니다', () => {
    expect(isNaturalBlackjack([card('10'), card('9')])).toBe(false);
  });
});

describe('dealerShouldHit', () => {
  test('합이 17 미만이면 히트해야 한다', () => {
    expect(dealerShouldHit([card('10'), card('6')])).toBe(true);
  });

  test('합이 17 이상이면 히트를 멈춰야 한다', () => {
    expect(dealerShouldHit([card('10'), card('7')])).toBe(false);
  });
});

describe('determineOutcome', () => {
  test('플레이어 점수가 더 높으면 WIN', () => {
    expect(determineOutcome([card('10'), card('9')], [card('10'), card('5')])).toBe('WIN');
  });

  test('딜러 점수가 더 높으면 LOSE', () => {
    expect(determineOutcome([card('10'), card('5')], [card('10'), card('9')])).toBe('LOSE');
  });

  test('점수가 같으면 PUSH', () => {
    expect(determineOutcome([card('10'), card('9')], [card('9'), card('K')])).toBe('PUSH');
  });

  test('딜러가 버스트하면 플레이어가 WIN', () => {
    expect(determineOutcome([card('10'), card('5')], [card('10'), card('9'), card('5')])).toBe('WIN');
  });

  test('플레이어만 자연블랙잭이면 NATURAL_WIN', () => {
    expect(determineOutcome([card('A'), card('K')], [card('10'), card('9')])).toBe('NATURAL_WIN');
  });

  test('둘 다 자연블랙잭이면 PUSH', () => {
    expect(determineOutcome([card('A'), card('K')], [card('A'), card('Q')])).toBe('PUSH');
  });
});

describe('calculatePayout', () => {
  test('LOSE면 지급액은 0이다', () => {
    expect(calculatePayout(1_000_000, 'LOSE')).toBe(0);
  });

  test('PUSH면 베팅금 그대로 환급한다', () => {
    expect(calculatePayout(1_000_000, 'PUSH')).toBe(1_000_000);
  });

  test('WIN이면 원금 + 원금만큼(1배)을 함께 돌려준다', () => {
    expect(calculatePayout(1_000_000, 'WIN')).toBe(2_000_000);
  });

  test('NATURAL_WIN이면 원금 + 1.5배 순수익을 돌려준다 (예: 1000 베팅 -> 순이익 1500)', () => {
    // 1000(원금) + floor(1000*1.5)=1500(순수익) = 2500
    expect(calculatePayout(1_000, 'NATURAL_WIN')).toBe(2_500);
  });

  test('NATURAL_WIN 순수익 계산에서 소수점은 내림 처리한다', () => {
    // floor(1_000_001 * 1.5) = floor(1_500_001.5) = 1_500_001
    expect(calculatePayout(1_000_001, 'NATURAL_WIN')).toBe(1_000_001 + 1_500_001);
  });
});

describe('validateBetAmount', () => {
  test('최소 베팅금(10만) 미만이면 거부한다', () => {
    expect(() => validateBetAmount(99_999, 10_000_000)).toThrow(BetTooSmallError);
  });

  test('정확히 최소 베팅금이면 통과한다', () => {
    expect(() => validateBetAmount(MIN_BET_AMOUNT, 10_000_000)).not.toThrow();
  });

  test('보유 포인트의 25% 초과면 거부한다', () => {
    // 보유 1,000,000 -> 최대 250,000
    expect(() => validateBetAmount(250_001, 1_000_000)).toThrow(BetTooLargeError);
  });

  test('정확히 25%(내림 처리)면 통과한다', () => {
    // 보유 1,000,003 -> floor(1,000,003*0.25)=250,000
    expect(() => validateBetAmount(250_000, 1_000_003)).not.toThrow();
  });

  test('MAX_BET_RATIO 상수가 0.25인지 확인 (스펙 고정값)', () => {
    expect(MAX_BET_RATIO).toBe(0.25);
  });
});

describe('createOrderedDeck / shuffleDeck', () => {
  test('덱은 52장이고 전부 서로 다른 카드다', () => {
    const deck = createOrderedDeck();
    expect(deck).toHaveLength(52);

    const unique = new Set(deck.map((c) => `${c.rank}${c.suit}`));
    expect(unique.size).toBe(52);
  });

  test('셔플해도 카드 구성(52장)은 그대로 유지된다', () => {
    const deck = createOrderedDeck();
    const shuffled = shuffleDeck(deck, () => 0.5);

    expect(shuffled).toHaveLength(52);
    const originalKeys = new Set(deck.map((c) => `${c.rank}${c.suit}`));
    const shuffledKeys = new Set(shuffled.map((c) => `${c.rank}${c.suit}`));
    expect(shuffledKeys).toEqual(originalKeys);
  });

  test('주어진 난수 함수가 결정적이면 셔플 결과도 결정적이다', () => {
    const deck = createOrderedDeck();
    const random = (() => {
      let seed = 1;
      return () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };
    })();

    const shuffled1 = shuffleDeck(createOrderedDeck(), (() => {
      let s = 1;
      return () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
      };
    })());
    const shuffled2 = shuffleDeck(deck, random);

    expect(shuffled1).toEqual(shuffled2);
  });
});
