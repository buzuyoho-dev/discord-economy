// 💡 이 파일은 `/가위바위보 [상대] [가위/바위/보] [베팅금]` 슬래시 커맨드를 처음 실행했을 때
// 벌어지는 일을 담당한다: 검증(자기자신/봇/잔액) -> 도전 메시지 발송(챌린저 선택은 절대 공개 안 함)
// -> 상대방 응답 대기(버튼 + 10분 타임아웃).
import { randomUUID } from 'node:crypto';
import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { buildChallengeEmbed, rpsErrorMessage } from '../discord/rpsView';
import { buildActionRow, RPS_ACTION_TIMEOUT_MS, voidRpsChallengeByTimeout } from '../events/rpsButton';
import { pendingRpsChallenges } from '../events/rpsState';
import { MIN_BET_AMOUNT } from '../services/blackjack';
import { RPS_CHOICES, type RpsChoice, validateOpponent } from '../services/rps';
import { startRpsChallenge } from '../services/rpsGame';

export const data = new SlashCommandBuilder()
  .setName('가위바위보')
  .setDescription(
    `다른 유저에게 가위바위보 대결을 신청합니다 (최소 ${MIN_BET_AMOUNT.toLocaleString()}P, 최대 보유 포인트의 25%, 승자 +95%/하우스 5%).`
  )
  .addUserOption((opt) => opt.setName('상대').setDescription('대결을 신청할 상대').setRequired(true))
  .addStringOption((opt) =>
    opt
      .setName('선택')
      .setDescription('낼 것을 고르세요 (다른 사람에게 절대 공개되지 않습니다)')
      .setRequired(true)
      .addChoices(...RPS_CHOICES.map((choice) => ({ name: choice, value: choice })))
  )
  .addIntegerOption((opt) =>
    opt.setName('베팅금').setDescription('베팅할 포인트 (최소 100,000)').setRequired(true).setMinValue(MIN_BET_AMOUNT)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const challengerId = interaction.user.id;
  const opponent = interaction.options.getUser('상대', true);
  const challengerChoice = interaction.options.getString('선택', true) as RpsChoice;
  const betAmount = interaction.options.getInteger('베팅금', true);

  try {
    // 💡 자기 자신/봇을 상대로 지목했는지 먼저 확인한다 (DB 조회 전에 걸러내는 게 더 저렴하다).
    validateOpponent(challengerId, { id: opponent.id, bot: opponent.bot ?? false });

    // 💡 챌린저 본인의 베팅 한도(10만~보유포인트 25%)와, 상대방이 베팅금만큼 갖고 있는지 확인한다.
    // 아직 아무 돈도 움직이지 않는다 - 실제 차감은 상대가 진짜로 수락했을 때만 일어난다.
    await startRpsChallenge({ challengerId, opponentId: opponent.id, betAmount });
  } catch (error) {
    const message = rpsErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  // 💡 이 도전을 가리키는 무작위 이름표를 만든다. 버튼 customId에는 이 challengeId만 실어
  // 보내고, 챌린저가 실제로 낸 선택(challengerChoice)은 아래 Map에만 저장한다.
  const challengeId = randomUUID();

  await interaction.reply({
    embeds: [buildChallengeEmbed({ challengerId, opponentId: opponent.id, betAmount })],
    components: [buildActionRow(challengeId)],
  });
  const message = await interaction.fetchReply();

  pendingRpsChallenges.set(challengeId, {
    challengerId,
    opponentId: opponent.id,
    betAmount,
    challengerChoice,
    timeout: setTimeout(() => {
      void voidRpsChallengeByTimeout({ challengeId, message });
    }, RPS_ACTION_TIMEOUT_MS),
  });
}
