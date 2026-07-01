import { describe, expect, test, vi } from 'vitest';
import { prisma } from '../../src/db/client';
import { LOTTERY_TICKET_PRICE } from '../../src/services/lottery';
import {
  formatLotteryStatusMessage,
  updateLotteryStatusMessage,
  type LotteryStatusChannel,
} from '../../src/services/lotteryStatusMessage';

function createFakeChannel() {
  const sent: string[] = [];
  const edited: { messageId: string; content: string }[] = [];
  let nextId = 1;

  const channel: LotteryStatusChannel = {
    sendMessage: async (content: string) => {
      sent.push(content);
      return { id: `msg-${nextId++}` };
    },
    editMessage: async (messageId: string, content: string) => {
      edited.push({ messageId, content });
    },
  };

  return { channel, sent, edited };
}

async function createTicket(userId: string, drawDate: Date, chosenNumber = 1) {
  return prisma.lotteryTicket.create({
    data: { userId, chosenNumber, amount: LOTTERY_TICKET_PRICE, drawDate },
  });
}

describe('formatLotteryStatusMessage', () => {
  test('회차 헤더, 참가자 목록, 이월 잭팟 줄을 포함한다', () => {
    const content = formatLotteryStatusMessage({
      drawDate: new Date('2026-07-02T00:00:00.000Z'),
      roundNumber: 47,
      participantUserIds: ['a', 'b', 'c'],
      carryoverJackpot: 3_000_000,
    });

    expect(content).toContain('[복권 7/2 47회차] 구매 현황');
    expect(content).toContain('참가자 (3명): <@a> <@b> <@c>');
    expect(content).toContain('이월 잭팟: 3,000,000P | 추첨: 매일 낮 12시');
  });

  test('고른 숫자는 노출하지 않는다', () => {
    const content = formatLotteryStatusMessage({
      drawDate: new Date('2026-07-02T00:00:00.000Z'),
      roundNumber: 1,
      participantUserIds: ['a'],
      carryoverJackpot: 0,
    });

    expect(content).not.toMatch(/\d+번/);
  });
});

describe('updateLotteryStatusMessage - 신규 회차 (첫 구매)', () => {
  test('새 메시지를 전송하고 회차 번호 1로 상태 레코드를 생성한다', async () => {
    const drawDate = new Date('2026-07-01T00:00:00.000Z');
    await createTicket('u1', drawDate);
    const { channel, sent } = createFakeChannel();

    await updateLotteryStatusMessage({ drawDate, channel });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('참가자 (1명)');
    expect(sent[0]).toContain('<@u1>');

    const record = await prisma.lotteryStatusMessage.findUnique({ where: { drawDate } });
    expect(record?.roundNumber).toBe(1);
    expect(record?.channelMessageId).toBe('msg-1');

    const state = await prisma.lotteryState.findUnique({ where: { id: 1 } });
    expect(state?.nextRoundNumber).toBe(2);
  });

  test('회차가 바뀌면 누적 회차 번호가 이어서 발급된다', async () => {
    const drawDate1 = new Date('2026-07-01T00:00:00.000Z');
    const drawDate2 = new Date('2026-07-02T00:00:00.000Z');

    await createTicket('a1', drawDate1);
    await updateLotteryStatusMessage({ drawDate: drawDate1, channel: createFakeChannel().channel });

    await createTicket('a2', drawDate2);
    await updateLotteryStatusMessage({ drawDate: drawDate2, channel: createFakeChannel().channel });

    const record1 = await prisma.lotteryStatusMessage.findUnique({ where: { drawDate: drawDate1 } });
    const record2 = await prisma.lotteryStatusMessage.findUnique({ where: { drawDate: drawDate2 } });
    expect(record1?.roundNumber).toBe(1);
    expect(record2?.roundNumber).toBe(2);
  });
});

describe('updateLotteryStatusMessage - 진행 중인 회차 (추가 구매)', () => {
  test('새 메시지를 보내지 않고 기존 메시지를 참가자 목록 갱신하여 edit한다', async () => {
    const drawDate = new Date('2026-07-01T00:00:00.000Z');
    const { channel, sent, edited } = createFakeChannel();

    await createTicket('u1', drawDate);
    await updateLotteryStatusMessage({ drawDate, channel });

    await createTicket('u2', drawDate);
    await updateLotteryStatusMessage({ drawDate, channel });

    expect(sent).toHaveLength(1);
    expect(edited).toHaveLength(1);
    expect(edited[0].messageId).toBe('msg-1');
    expect(edited[0].content).toContain('참가자 (2명)');
    expect(edited[0].content).toContain('<@u1>');
    expect(edited[0].content).toContain('<@u2>');

    const record = await prisma.lotteryStatusMessage.findUnique({ where: { drawDate } });
    expect(record?.roundNumber).toBe(1);
  });
});

describe('updateLotteryStatusMessage - 메시지 전송/수정 실패', () => {
  test('메시지 전송이 실패해도 예외를 던지지 않고 로그만 남긴다', async () => {
    const drawDate = new Date('2026-07-01T00:00:00.000Z');
    await createTicket('u1', drawDate);
    const channel: LotteryStatusChannel = {
      sendMessage: async () => {
        throw new Error('디스코드 전송 실패');
      },
      editMessage: async () => {},
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(updateLotteryStatusMessage({ drawDate, channel })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  test('메시지 수정이 실패해도 예외를 던지지 않고 로그만 남긴다', async () => {
    const drawDate = new Date('2026-07-01T00:00:00.000Z');
    const { channel } = createFakeChannel();

    await createTicket('u1', drawDate);
    await updateLotteryStatusMessage({ drawDate, channel });

    await createTicket('u2', drawDate);
    const failingChannel: LotteryStatusChannel = {
      sendMessage: channel.sendMessage,
      editMessage: async () => {
        throw new Error('디스코드 수정 실패');
      },
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      updateLotteryStatusMessage({ drawDate, channel: failingChannel })
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
