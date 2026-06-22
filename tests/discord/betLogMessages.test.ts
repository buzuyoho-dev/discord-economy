import { describe, expect, test } from 'vitest';
import { formatMode1Settle } from '../../src/discord/betLogMessages';

describe('formatMode1Settle', () => {
  const options = [
    { id: 10, label: '승' },
    { id: 11, label: '패' },
  ];

  test('정산 시 각 참가자의 닉네임과 선택했던 옵션을 공개한다', () => {
    const settled = {
      id: 2,
      status: 'SETTLED',
      title: '아시아솔랭',
      creatorId: 'host1',
      entryResults: [
        { userId: 'winner1', optionId: 10, creditedAmount: 5_000_000 },
        { userId: 'loser1', optionId: 11, creditedAmount: 0 },
      ],
    };

    const message = formatMode1Settle(settled, options, 10);

    expect(message).toContain('- <@winner1>: 승 ✅ (+5,000,000)');
    expect(message).toContain('- <@loser1>: 패 ❌');
  });

  test('무효(VOID) 처리 시에도 각 참가자의 선택을 공개한다', () => {
    const settled = {
      id: 3,
      status: 'VOID',
      title: '무효 베팅',
      creatorId: 'host1',
      entryResults: [{ userId: 'voter1', optionId: 10, creditedAmount: 1_000 }],
    };

    const message = formatMode1Settle(settled, options, 10);

    expect(message).toContain('- <@voter1>: 승 (환불 +1,000)');
  });
});
