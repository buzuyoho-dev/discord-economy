import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { listValidCoupons } from '../services/coupon';

const EXPIRING_SOON_MS = 3 * 24 * 60 * 60 * 1000;

export const data = new SlashCommandBuilder()
  .setName('쿠폰함')
  .setDescription('내가 보유한 미사용 베팅2배쿠폰 목록을 확인합니다.');

export async function execute(interaction: ChatInputCommandInteraction) {
  const now = new Date();
  const coupons = await listValidCoupons(interaction.user.id, now);

  if (coupons.length === 0) {
    await interaction.reply({
      content: '보유 중인 베팅2배쿠폰이 없습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = coupons.map((coupon, index) => {
    const remainingMs = coupon.expiresAt.getTime() - now.getTime();
    const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
    const expiryLabel = `<t:${Math.floor(coupon.expiresAt.getTime() / 1000)}:R>`;
    const warning = remainingMs <= EXPIRING_SOON_MS ? ` ⚠️ ${remainingDays}일 후 소멸` : '';
    return `${index + 1}. 만료: ${expiryLabel}${warning}`;
  });

  await interaction.reply({
    content: [`🎟️ **베팅2배쿠폰 보유 수: ${coupons.length}개**`, ...lines].join('\n'),
    flags: MessageFlags.Ephemeral,
  });
}
