// 💡 이 파일은 게임 도중 유저가 [히트]/[스탠드] 버튼을 눌렀을 때(또는 60초 동안 아무것도
// 안 눌러서 자동으로 스탠드 처리될 때) 무슨 일이 일어나는지를 담당한다.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Message,
  MessageFlags,
} from 'discord.js';
import { buildInProgressEmbed, buildResultEmbed } from '../discord/blackjackView';
import {
  calculatePayout,
  dealerShouldHit,
  determineOutcome,
  isBust,
} from '../services/blackjack';
import { settleBlackjackGame } from '../services/blackjackGame';
import { activeBlackjackGames } from './blackjackState';

const HIT_PREFIX = 'blackjack:hit:';
const STAND_PREFIX = 'blackjack:stand:';
export const BLACKJACK_ACTION_TIMEOUT_MS = 60_000;

export function isBlackjackActionButton(customId: string): boolean {
  return customId.startsWith(HIT_PREFIX) || customId.startsWith(STAND_PREFIX);
}

// 💡 [히트]/[스탠드] 버튼 2개짜리 줄을 만든다. customId에 유저 discordId를 실어 보내서,
// 나중에 버튼이 눌렸을 때 "누가 눌렀는지"와 "이 게임 주인이 맞는지"를 확인할 수 있게 한다.
export function buildActionRow(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${HIT_PREFIX}${userId}`).setLabel('히트').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${STAND_PREFIX}${userId}`).setLabel('스탠드').setStyle(ButtonStyle.Secondary)
  );
}

// 💡 게임을 마무리 짓는 공통 함수. 아래 3가지 상황이 전부 여기로 모인다:
//   1) 히트했다가 21을 넘어서(버스트) 바로 패배가 확정됐을 때
//   2) 유저가 [스탠드]를 눌렀을 때
//   3) 60초 동안 아무 버튼도 안 눌러서 자동으로 스탠드 처리될 때
// 실제 메시지를 보낸 interaction이 없어도(타임아웃은 그냥 타이머라서) 동작할 수 있도록,
// discord.js의 Message 객체를 직접 받아서 그걸로 수정(edit)한다.
export async function finishBlackjackGame(params: {
  userId: string;
  message: Message;
  playerBusted: boolean;
  autoStand: boolean;
}): Promise<void> {
  const game = activeBlackjackGames.get(params.userId);
  if (!game) {
    // 💡 이미 다른 경로로 끝나서 Map에서 지워진 게임이면 아무것도 하지 않는다
    // (예: 스탠드를 눌렀는데 그 직후 타이머도 동시에 발동한 경우의 안전장치).
    return;
  }

  // 💡 이 판은 이제 끝나는 거니까, 남아있던 60초 타이머는 취소하고 진행 중 목록에서 뺀다.
  clearTimeout(game.timeout);
  activeBlackjackGames.delete(params.userId);

  let dealerHand = game.dealerHand;
  let deck = game.deck;

  if (!params.playerBusted) {
    // 💡 플레이어가 버스트하지 않았다면, 이제 딜러 차례다. 딜러는 사람처럼 고민하지 않고
    // "17 이상이 될 때까지 무조건 히트"라는 정해진 규칙만 따른다.
    while (dealerShouldHit(dealerHand)) {
      const [drawn, ...rest] = deck;
      dealerHand = [...dealerHand, drawn];
      deck = rest;
    }
  }

  // 💡 버스트했으면 볼 것도 없이 패배, 아니면 최종 패끼리 비교해서 승패를 정한다.
  const outcome = params.playerBusted ? 'LOSE' : determineOutcome(game.playerHand, dealerHand);
  const payout = calculatePayout(game.betAmount, outcome);

  const settleResult = await settleBlackjackGame({
    discordId: params.userId,
    betAmount: game.betAmount,
    outcome,
  });

  const embed = buildResultEmbed({
    playerHand: game.playerHand,
    dealerHand,
    betAmount: game.betAmount,
    outcome,
    payout,
    balanceAfter: settleResult.balanceAfter,
    playsRemaining: settleResult.playsRemaining,
    autoStand: params.autoStand,
  });

  // 💡 버튼은 이제 필요 없으니(게임이 끝났으니) components를 빈 배열로 줘서 없애버린다.
  await params.message.edit({ embeds: [embed], components: [] }).catch((error) => {
    console.error('블랙잭 결과 메시지 갱신 실패', error);
  });
}

// 💡 [히트] 버튼: 카드를 한 장 더 받는다.
async function handleHit(interaction: ButtonInteraction, userId: string): Promise<void> {
  const game = activeBlackjackGames.get(userId);
  if (!game) {
    await interaction.reply({ content: '이미 종료된 게임입니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  // 💡 덱 맨 위 카드를 한 장 뽑아서 내 손패에 추가한다.
  const [drawn, ...remainingDeck] = game.deck;
  game.playerHand = [...game.playerHand, drawn];
  game.deck = remainingDeck;

  // 💡 버튼 클릭에 일단 "확인했어요"라고 응답해둔다 (아래 DB 작업이 3초 넘게 걸릴 수도 있어서).
  await interaction.deferUpdate();

  if (isBust(game.playerHand)) {
    await finishBlackjackGame({ userId, message: interaction.message, playerBusted: true, autoStand: false });
    return;
  }

  // 💡 아직 안 끝났으면, 새로 받은 카드를 반영한 화면으로 갱신하고 60초 타이머를 다시 건다.
  clearTimeout(game.timeout);
  game.timeout = setTimeout(() => {
    void finishBlackjackGame({ userId, message: interaction.message, playerBusted: false, autoStand: true });
  }, BLACKJACK_ACTION_TIMEOUT_MS);

  await interaction.editReply({
    embeds: [
      buildInProgressEmbed({
        playerHand: game.playerHand,
        dealerHand: game.dealerHand,
        betAmount: game.betAmount,
      }),
    ],
    components: [buildActionRow(userId)],
  });
}

// 💡 [스탠드] 버튼: 더 안 받고 승부를 본다.
async function handleStand(interaction: ButtonInteraction, userId: string): Promise<void> {
  const game = activeBlackjackGames.get(userId);
  if (!game) {
    await interaction.reply({ content: '이미 종료된 게임입니다.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferUpdate();
  await finishBlackjackGame({ userId, message: interaction.message, playerBusted: false, autoStand: false });
}

export async function handleBlackjackActionButton(interaction: ButtonInteraction): Promise<void> {
  const isHit = interaction.customId.startsWith(HIT_PREFIX);
  const userId = interaction.customId.slice(isHit ? HIT_PREFIX.length : STAND_PREFIX.length);

  // 💡 이 게임은 처음 시작한 사람만 조작할 수 있다 (다른 사람이 실수로/장난으로 못 누르게).
  if (interaction.user.id !== userId) {
    await interaction.reply({
      content: '본인이 시작한 게임에서만 사용할 수 있습니다.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (isHit) {
    await handleHit(interaction, userId);
  } else {
    await handleStand(interaction, userId);
  }
}
