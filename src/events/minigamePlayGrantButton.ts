// 💡 "/횟수지급"을 전체 유저 대상으로 실행했을 때 뜨는 확인/취소 버튼을 처리한다.
import type { ButtonInteraction } from 'discord.js';
import { env } from '../config/env';
import { NotAdminError } from '../services/adminGrant';
import { grantMinigamePlays, InvalidPlayGrantCountError, MINIGAME_REGISTRY } from '../services/minigamePlayGrant';
import { pendingPlayGrants } from './minigamePlayGrantState';

const CONFIRM_PREFIX = 'playgrant:confirm:';
const CANCEL_PREFIX = 'playgrant:cancel:';

export function isPlayGrantButton(customId: string): boolean {
  return customId.startsWith(CONFIRM_PREFIX) || customId.startsWith(CANCEL_PREFIX);
}

export async function handlePlayGrantButton(interaction: ButtonInteraction): Promise<void> {
  const isConfirm = interaction.customId.startsWith(CONFIRM_PREFIX);
  const pendingId = interaction.customId.slice(isConfirm ? CONFIRM_PREFIX.length : CANCEL_PREFIX.length);

  if (!isConfirm) {
    pendingPlayGrants.delete(pendingId);
    await interaction.update({
      content: '횟수 지급을 취소했습니다. 아무 변경도 이루어지지 않았습니다.',
      components: [],
    });
    return;
  }

  // 💡 확인 버튼은 한 번 쓰면 바로 지운다 - 같은 버튼을 두 번 눌러도 두 번 지급되지 않게 막는
  // 역할도 겸한다.
  const pending = pendingPlayGrants.get(pendingId);
  pendingPlayGrants.delete(pendingId);

  if (!pending) {
    await interaction.update({
      content: '❌ 만료되었거나 이미 처리된 요청입니다. 명령어를 다시 실행해주세요.',
      components: [],
    });
    return;
  }

  try {
    // 💡 미리보기 시점의 유저 목록이 아니라 지금 이 순간 DB에 있는 "전체 유저"를 다시 조회해서
    // 반영한다 (미리보기와 확인 사이에 신규 유저가 생겼을 수도 있으므로) - /정산취소 confirm
    // 핸들러가 DB를 재조회하는 것과 같은 이유다.
    const result = await grantMinigamePlays({
      game: pending.game,
      count: pending.count,
      reason: pending.reason,
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
    });

    await interaction.update({
      content: `✅ ${MINIGAME_REGISTRY[pending.game].label} 잔여 횟수 +${pending.count}를 전체 유저 ${result.targetUserIds.length}명에게 지급했습니다.`,
      components: [],
    });
  } catch (error) {
    let message: string | null = null;
    if (error instanceof NotAdminError) {
      message = '관리자만 사용할 수 있습니다.';
    } else if (error instanceof InvalidPlayGrantCountError) {
      message = '횟수는 1 이상의 정수여야 합니다.';
    }

    if (!message) {
      throw error;
    }

    await interaction.update({ content: `❌ ${message}`, components: [] });
  }
}
