// 💡 관리자가 미니게임의 "오늘 잔여 플레이 횟수"를 유저(들)에게 지급하는 상시 커맨드.
// 이벤트가 있을 때마다 1회성 스크립트를 새로 만드는 대신 이 커맨드 하나로 처리한다.
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { env } from '../config/env';
import { pendingPlayGrants } from '../events/minigamePlayGrantState';
import { NotAdminError } from '../services/adminGrant';
import {
  grantMinigamePlays,
  InvalidPlayGrantCountError,
  MINIGAME_REGISTRY,
  type MinigameChoice,
  previewMinigamePlayGrant,
} from '../services/minigamePlayGrant';

export const data = new SlashCommandBuilder()
  .setName('횟수지급')
  .setDescription('(관리자 전용) 미니게임 오늘 잔여 플레이 횟수를 지급합니다.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((opt) =>
    opt
      .setName('게임')
      .setDescription('대상 미니게임')
      .setRequired(true)
      .addChoices(
        ...Object.entries(MINIGAME_REGISTRY).map(([value, config]) => ({ name: config.label, value }))
      )
  )
  .addIntegerOption((opt) =>
    opt.setName('횟수').setDescription('지급할 횟수').setRequired(true).setMinValue(1)
  )
  .addUserOption((opt) =>
    opt.setName('유저').setDescription('지정하지 않으면 DB의 전체 유저가 대상입니다')
  )
  .addStringOption((opt) => opt.setName('사유').setDescription('지급 사유 (선택)'));

export async function execute(interaction: ChatInputCommandInteraction) {
  const game = interaction.options.getString('게임', true) as MinigameChoice;
  const count = interaction.options.getInteger('횟수', true);
  const targetUser = interaction.options.getUser('유저');
  const reason = interaction.options.getString('사유') ?? undefined;
  const gameLabel = MINIGAME_REGISTRY[game].label;

  try {
    if (targetUser) {
      // 💡 유저를 지정하면 미리보기/확인 절차 없이 바로 지급한다
      // (요구사항: 확인 버튼은 "전체" 대상일 때만 필요).
      const result = await grantMinigamePlays({
        game,
        targetUserId: targetUser.id,
        count,
        reason,
        requestedBy: interaction.user.id,
        adminDiscordId: env.ADMIN_DISCORD_ID,
      });
      const item = result.plan[0];
      await interaction.reply({
        content: `✅ ${gameLabel} 잔여 횟수를 지급했습니다.\n<@${targetUser.id}>: ${item.playsRemainingBefore} -> ${item.playsRemainingAfter}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 💡 유저를 지정하지 않으면 "전체 유저" 대상 - 몇 명에게 적용될지 먼저 보여주고, 확인 버튼을
    // 눌러야 실제로 반영되게 한다.
    const preview = await previewMinigamePlayGrant({
      game,
      count,
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
    });

    // 💡 "사유"는 자유 텍스트라 버튼 customId(100자 제한)에 못 넣으므로, 서버 메모리에 잠깐
    // 저장해두고 customId에는 이 요청을 가리키는 무작위 id만 싣는다.
    const pendingId = randomUUID();
    pendingPlayGrants.set(pendingId, { game, count, reason, requestedBy: interaction.user.id });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`playgrant:confirm:${pendingId}`)
        .setLabel('확인')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`playgrant:cancel:${pendingId}`)
        .setLabel('취소')
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      content: [
        `⚠️ ${gameLabel} 잔여 횟수를 **전체 유저 ${preview.targetUserIds.length}명**에게 +${count}씩 지급합니다.`,
        reason ? `사유: ${reason}` : null,
        '아래 확인 버튼을 눌러야 실제로 반영됩니다.',
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (error instanceof NotAdminError) {
      await interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (error instanceof InvalidPlayGrantCountError) {
      await interaction.reply({
        content: '횟수는 1 이상의 정수여야 합니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    throw error;
  }
}
