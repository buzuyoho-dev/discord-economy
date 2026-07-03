// 💡 이 파일은 `/포인트내역` 슬래시 커맨드를 담당한다: 관리자가 특정 유저(또는 전체)의
// 포인트 거래 기록(Transaction)을 최신순으로 조회한다. 새 테이블/함수를 만들지 않고,
// 이미 모든 정산/복권/환급 등에서 쓰이는 기존 Transaction 원장을 그대로 읽기만 한다.
import {
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { env } from '../config/env';
import { formatTransactionLineWithUser } from '../discord/transactionView';
import { NotAdminError } from '../services/adminGrant';
import { getPointHistory, MAX_POINT_HISTORY_LIMIT } from '../services/pointHistory';

export const data = new SlashCommandBuilder()
  .setName('포인트내역')
  .setDescription('(관리자 전용) 유저별 포인트 증감 내역을 조회합니다.')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addUserOption((opt) =>
    opt
      .setName('유저')
      .setDescription('특정 유저만 조회하려면 선택하세요 (안 하면 전체 최근 내역)')
      .setRequired(false)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('개수')
      .setDescription(`조회할 개수 (기본 10개, 최대 ${MAX_POINT_HISTORY_LIMIT}개)`)
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(MAX_POINT_HISTORY_LIMIT)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const targetUser = interaction.options.getUser('유저');
  const limit = interaction.options.getInteger('개수') ?? undefined;

  try {
    const transactions = await getPointHistory({
      requestedBy: interaction.user.id,
      adminDiscordId: env.ADMIN_DISCORD_ID,
      userId: targetUser?.id,
      limit,
    });

    if (transactions.length === 0) {
      await interaction.reply({ content: '📭 조회된 포인트 변동 내역이 없습니다.', flags: MessageFlags.Ephemeral });
      return;
    }

    const title = targetUser
      ? `📊 <@${targetUser.id}>님의 포인트 내역 (최근 ${transactions.length}건)`
      : `📊 전체 최근 포인트 내역 (최근 ${transactions.length}건)`;
    const lines = transactions.map((tx) => formatTransactionLineWithUser(tx));

    await interaction.reply({
      content: `${title}\n${lines.join('\n')}`,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { users: [] },
    });
  } catch (error) {
    if (error instanceof NotAdminError) {
      await interaction.reply({ content: '관리자만 사용할 수 있습니다.', flags: MessageFlags.Ephemeral });
      return;
    }
    throw error;
  }
}
