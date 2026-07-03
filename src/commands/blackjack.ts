// 💡 이 파일은 `/블랙잭 [베팅금액]` 슬래시 커맨드를 처음 실행했을 때 벌어지는 일을 담당한다:
// 검증 -> 베팅금 차감 -> 카드 배분 -> (자연블랙잭이면 바로 종료, 아니면) 히트/스탠드 버튼 표시.
import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { blackjackErrorMessage, buildInProgressEmbed, buildResultEmbed } from '../discord/blackjackView';
import { BLACKJACK_ACTION_TIMEOUT_MS, buildActionRow, finishBlackjackGame } from '../events/blackjackButton';
import { activeBlackjackGames } from '../events/blackjackState';
import {
  calculatePayout,
  createOrderedDeck,
  determineOutcome,
  isNaturalBlackjack,
  MIN_BET_AMOUNT,
  shuffleDeck,
} from '../services/blackjack';
import { settleBlackjackGame, startBlackjackGame } from '../services/blackjackGame';

export const data = new SlashCommandBuilder()
  .setName('블랙잭')
  .setDescription(
    `하우스와 1대1로 블랙잭을 합니다 (최소 ${MIN_BET_AMOUNT.toLocaleString()}P, 최대 보유 포인트의 25%, 하루 5회).`
  )
  .addIntegerOption((opt) =>
    opt
      .setName('베팅금액')
      .setDescription('베팅할 포인트 (최소 100,000)')
      .setRequired(true)
      .setMinValue(MIN_BET_AMOUNT)
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const userId = interaction.user.id;
  const betAmount = interaction.options.getInteger('베팅금액', true);

  // 💡 이미 진행 중인 게임이 있으면(Map에 이 유저 키가 있으면) 새로 시작하지 못하게 막는다.
  // 한 사람이 동시에 두 판을 하면 베팅금 계산이 꼬일 수 있어서다.
  if (activeBlackjackGames.has(userId)) {
    await interaction.reply({
      content: '이미 진행 중인 블랙잭 게임이 있습니다. 먼저 끝내주세요.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    // 💡 여기서 "오늘 5회 넘었는지", "베팅금이 10만~보유포인트 25% 사이인지"를 확인하고,
    // 전부 통과하면 베팅금을 즉시 차감한다. (원자적 트랜잭션이라 동시 요청에도 안전하다)
    await startBlackjackGame({ discordId: userId, betAmount });
  } catch (error) {
    const message = blackjackErrorMessage(error);
    if (!message) {
      throw error;
    }
    await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    return;
  }

  // 💡 카드 52장을 잘 섞고, 플레이어와 딜러에게 순서대로 2장씩 나눠준다.
  const shuffled = shuffleDeck(createOrderedDeck());
  const playerHand = [shuffled[0], shuffled[1]];
  const dealerHand = [shuffled[2], shuffled[3]];
  const remainingDeck = shuffled.slice(4);

  // 💡 둘 중 하나라도 처음 2장으로 21(자연블랙잭)이 나왔으면, 히트/스탠드 없이 바로 승부가 난다.
  if (isNaturalBlackjack(playerHand) || isNaturalBlackjack(dealerHand)) {
    const outcome = determineOutcome(playerHand, dealerHand);
    const settleResult = await settleBlackjackGame({ discordId: userId, betAmount, outcome });

    await interaction.reply({
      embeds: [
        buildResultEmbed({
          playerHand,
          dealerHand,
          betAmount,
          outcome,
          payout: calculatePayout(betAmount, outcome),
          balanceAfter: settleResult.balanceAfter,
          playsRemaining: settleResult.playsRemaining,
          autoStand: false,
        }),
      ],
    });
    return;
  }

  // 💡 아직 승부가 안 났으면 히트/스탠드 버튼이 달린 메시지를 보여준다.
  await interaction.reply({
    embeds: [buildInProgressEmbed({ playerHand, dealerHand, betAmount })],
    components: [buildActionRow(userId)],
  });
  const message = await interaction.fetchReply();

  // 💡 지금 이 판의 상태(카드/베팅금)를 메모리에 잠깐 저장해둔다. 60초 동안 버튼을 안 누르면
  // 자동으로 스탠드 처리되도록 타이머도 같이 걸어둔다.
  activeBlackjackGames.set(userId, {
    deck: remainingDeck,
    playerHand,
    dealerHand,
    betAmount,
    timeout: setTimeout(() => {
      void finishBlackjackGame({ userId, message, playerBusted: false, autoStand: true });
    }, BLACKJACK_ACTION_TIMEOUT_MS),
  });
}
