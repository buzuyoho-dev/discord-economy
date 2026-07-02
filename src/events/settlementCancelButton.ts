import { type ButtonInteraction } from 'discord.js';
import { env } from '../config/env';
import { logBetEvent } from '../discord/betLog';
import { formatSettlementCancelLog } from '../discord/betLogMessages';
import { NotAdminError } from '../services/adminGrant';
import { BetNotFoundError, BetNotSettledError } from '../services/betShared';
import { cancelSettlement } from '../services/settlementCancellation';

const CONFIRM_PREFIX = 'settlementcancel:confirm:';
const CANCEL_PREFIX = 'settlementcancel:cancel:';

export function isSettlementCancelButton(customId: string): boolean {
  return customId.startsWith(CONFIRM_PREFIX) || customId.startsWith(CANCEL_PREFIX);
}

export async function handleSettlementCancelButton(interaction: ButtonInteraction) {
  const isConfirm = interaction.customId.startsWith(CONFIRM_PREFIX);
  const betId = Number(
    interaction.customId.slice(isConfirm ? CONFIRM_PREFIX.length : CANCEL_PREFIX.length)
  );

  if (!isConfirm) {
    await interaction.update({
      content: '정산취소를 취소했습니다. 아무 변경도 이루어지지 않았습니다.',
      components: [],
    });
    return;
  }

  try {
    const plan = await cancelSettlement({
      betId,
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
    });

    await interaction.update({
      content: `✅ 베팅#${betId} 정산취소가 완료됐습니다. 참가자 ${plan.corrections.length}명의 잔액을 상쇄했습니다. \`/베팅정산\` 또는 \`/모드2베팅정산\`으로 다시 정산할 수 있습니다.`,
      components: [],
    });

    await logBetEvent(interaction.client, formatSettlementCancelLog(plan, interaction.user.id));
  } catch (error) {
    let message: string | null = null;
    if (error instanceof NotAdminError) {
      message = '관리자만 사용할 수 있습니다.';
    } else if (error instanceof BetNotFoundError) {
      message = '해당 베팅을 찾을 수 없습니다.';
    } else if (error instanceof BetNotSettledError) {
      message = '이미 처리되었거나 정산되지 않은 베팅입니다.';
    }

    if (!message) {
      throw error;
    }

    await interaction.update({ content: `❌ ${message}`, components: [] });
  }
}
