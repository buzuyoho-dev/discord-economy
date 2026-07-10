import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { describe, expect, test } from 'vitest';
import { buildRebateAnnouncementEmbed } from '../../src/discord/rebateAnnouncement';

describe('buildRebateAnnouncementEmbed - 정상 지급', () => {
  test('소수 유저면 필드 1개에 금액 내림차순으로 담긴다', () => {
    const { embed, file } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: true,
      totalDistributed: 500_000,
      perUserAmounts: [
        { discordId: 'u1', amount: 300_000 },
        { discordId: 'u2', amount: 200_000 },
      ],
      houseBalanceAfter: 37_000_003,
      totalEconomy: 92_500_000,
      capRatio: 0.4,
    });

    expect(embed).toBeInstanceOf(EmbedBuilder);
    expect(embed.data.title).toBe('💰 환급 지급 완료 (주간 정기 배치)');
    expect(embed.data.description).toContain('500,000P');
    expect(embed.data.description).toContain('37,000,003P');
    expect(embed.data.description).toContain('40.0%'); // 37,000,003/92,500,000 ≈ 40.0%
    expect(embed.data.description).toContain('목표 40% 이하');
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields![0].name).toBe('지급 내역');
    expect(embed.data.fields![0].value.indexOf('u1')).toBeLessThan(
      embed.data.fields![0].value.indexOf('u2')
    );
    expect(embed.data.fields![0].value).toContain('<@u1>: 300,000P');
    expect(embed.data.fields![0].value).toContain('<@u2>: 200,000P');
    expect(file).toBeUndefined();
  });

  test('CATCH_UP 사유면 제목이 다르다', () => {
    const { embed } = buildRebateAnnouncementEmbed({
      reason: 'CATCH_UP',
      distributed: true,
      totalDistributed: 100,
      perUserAmounts: [{ discordId: 'u1', amount: 100 }],
      houseBalanceAfter: 1000,
      totalEconomy: 10_000,
      capRatio: 0.4,
    });

    expect(embed.data.title).toBe('💰 하우스 캡 초과분 catch-up 정산 완료');
  });
});

describe('buildRebateAnnouncementEmbed - 환급 없음', () => {
  test('distributed=false면 간단한 임베드만 만들고 유저별 내역 필드가 없다', () => {
    const { embed, file } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: false,
      totalDistributed: 0,
      perUserAmounts: [],
      houseBalanceAfter: 1_000_000,
      totalEconomy: 6_000_000,
      capRatio: 0.4,
    });

    expect(embed.data.title).toBe('📭 이번 회차 환급 없음');
    expect(embed.data.description).toContain('환급이 지급되지 않았습니다');
    expect(embed.data.fields ?? []).toHaveLength(0);
    expect(file).toBeUndefined();
  });
});

describe('buildRebateAnnouncementEmbed - 필드 여러 개로 분할 (25개 이내)', () => {
  test('유저가 많으면 여러 필드로 나뉘지만 25개를 넘지 않는다', () => {
    const perUserAmounts = Array.from({ length: 60 }, (_, i) => ({
      discordId: `user${i + 1}`,
      amount: 1_000_000 + i,
    }));

    const { embed, file } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: true,
      totalDistributed: perUserAmounts.reduce((sum, u) => sum + u.amount, 0),
      perUserAmounts,
      houseBalanceAfter: 37_000_000,
      totalEconomy: 92_500_000,
      capRatio: 0.4,
    });

    expect(file).toBeUndefined();
    expect(embed.data.fields!.length).toBeGreaterThan(1);
    expect(embed.data.fields!.length).toBeLessThanOrEqual(25);
    for (const field of embed.data.fields!) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    const allFieldText = embed.data.fields!.map((f) => f.value).join('\n');
    for (const user of perUserAmounts) {
      expect(allFieldText).toContain(`<@${user.discordId}>`);
    }
  });
});

describe('buildRebateAnnouncementEmbed - 필드 25개 초과 시 첨부파일 폴백', () => {
  test('유저가 매우 많으면(필드 25개 초과) 전체 명단을 .txt 첨부파일로 대신 보낸다', () => {
    const perUserAmounts = Array.from({ length: 2000 }, (_, i) => ({
      discordId: `user${i + 1}`,
      amount: 1_000_000,
    }));

    const { embed, file } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: true,
      totalDistributed: perUserAmounts.length * 1_000_000,
      perUserAmounts,
      houseBalanceAfter: 37_000_000,
      totalEconomy: 92_500_000,
      capRatio: 0.4,
    });

    expect(file).toBeInstanceOf(AttachmentBuilder);
    expect(file!.name).toBe('rebate-recipients.txt');
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields![0].value).toContain('2000명');
    expect(embed.data.fields![0].value).toContain('첨부파일 참고');
  });
});

describe('buildRebateAnnouncementEmbed - 임베드 총 길이 제한(6000자)', () => {
  test('필드 25개는 안 넘지만 임베드 총 길이가 넘으면 첨부파일로 폴백한다', () => {
    // 실제 디스코드 스노우플레이크(18자리)와 비슷한 길이의 ID + 백만 단위 금액을 쓰면
    // 유저 1명당 줄 길이가 약 33자가 되어, 250명이면 필드는 약 9개뿐이라 25개 제한에는
    // 안 걸리지만 임베드 총 길이(제목+설명+9개 필드)는 6000자를 훌쩍 넘는다 - 25필드
    // 제한만 있던 예전 코드였다면 여기서 정상 임베드로 잘못 처리됐을 상황이다.
    const perUserAmounts = Array.from({ length: 250 }, (_, i) => ({
      discordId: `1${String(i).padStart(17, '0')}`,
      amount: 1_000_000 + i,
    }));

    const { embed, file } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: true,
      totalDistributed: perUserAmounts.reduce((sum, u) => sum + u.amount, 0),
      perUserAmounts,
      houseBalanceAfter: 37_000_000,
      totalEconomy: 92_500_000,
      capRatio: 0.4,
    });

    expect(file).toBeInstanceOf(AttachmentBuilder);
    expect(embed.data.fields).toHaveLength(1);
    expect(embed.data.fields![0].value).toContain('250명');
  });
});

describe('buildRebateAnnouncementEmbed - 전체 경제 규모 0', () => {
  test('totalEconomy가 0이면 퍼센트가 0%로 안전하게 표시된다', () => {
    const { embed } = buildRebateAnnouncementEmbed({
      reason: 'WEEKLY_BATCH',
      distributed: false,
      totalDistributed: 0,
      perUserAmounts: [],
      houseBalanceAfter: 0,
      totalEconomy: 0,
      capRatio: 0.4,
    });

    expect(embed.data.description).toContain('0.0%');
  });
});
