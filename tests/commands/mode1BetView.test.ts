import { describe, expect, test } from 'vitest';
import { buildBetAnnouncement } from '../../src/commands/mode1BetView';

const bet = {
  id: 1,
  title: '오늘 1킬 이상이냐',
  amount: 1_000_000,
  status: 'OPEN',
  options: [{ label: '1킬 이상' }, { label: '0킬' }],
};

describe('buildBetAnnouncement', () => {
  test('참가자가 없으면 참가자 (0명): 없음을 보여준다', () => {
    const text = buildBetAnnouncement(bet, []);

    expect(text).toContain('참가자 (0명): 없음');
    expect(text).not.toContain('참가자 수');
  });

  test('참가자 수 대신 참가자 멘션 목록을 보여준다', () => {
    const text = buildBetAnnouncement(bet, ['user-1', 'user-2', 'user-3']);

    expect(text).toContain('참가자 (3명): <@user-1> <@user-2> <@user-3>');
    expect(text).not.toContain('참가자 수');
  });

  test('각자의 선택(옵션)은 공개 안내문에 노출하지 않는다', () => {
    const text = buildBetAnnouncement(bet, ['user-1', 'user-2']);

    expect(text).toContain('선택은 비공개');
  });
});
