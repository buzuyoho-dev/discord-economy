import { describe, expect, test } from 'vitest';
import { buildMode2BetAnnouncement } from '../../src/commands/mode2BetView';

const bet = {
  id: 1,
  title: '오늘 이길까',
  status: 'OPEN',
  sideALabel: '성공',
  sideBLabel: '실패',
};

describe('buildMode2BetAnnouncement', () => {
  test('참가자가 없으면 참가자 (0명): 없음을 보여준다', () => {
    const text = buildMode2BetAnnouncement(bet, []);

    expect(text).toContain('참가자 (0명): 없음');
  });

  test('참가자 멘션 목록을 보여준다', () => {
    const text = buildMode2BetAnnouncement(bet, ['user-1', 'user-2', 'user-3']);

    expect(text).toContain('참가자 (3명): <@user-1> <@user-2> <@user-3>');
  });

  test('각자가 고른 사이드는 공개 안내문에 노출하지 않는다', () => {
    const text = buildMode2BetAnnouncement(bet, ['user-1', 'user-2']);

    expect(text).toContain('선택은 비공개');
    expect(text).not.toMatch(/user-1.*(성공|실패)/);
  });
});
