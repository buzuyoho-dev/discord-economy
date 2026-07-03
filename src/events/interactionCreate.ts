import { type Interaction, MessageFlags } from 'discord.js';
import { commands } from '../commands';
import { handleBlackjackActionButton, isBlackjackActionButton } from './blackjackButton';
import { handleMode1BetJoinButton, isMode1BetJoinButton } from './mode1BetButton';
import {
  handleMode2BetAmountModal,
  handleMode2BetChooseButton,
  isMode2BetAmountModal,
  isMode2BetChooseButton,
} from './mode2BetInteraction';
import { handleRpsActionButton, isRpsActionButton } from './rpsButton';
import { handleSettlementCancelButton, isSettlementCancelButton } from './settlementCancelButton';
import {
  handleUnifiedBetAmountModal,
  handleUnifiedBetChooseButton,
  handleUnifiedBetCouponChoiceButton,
  isUnifiedBetAmountModal,
  isUnifiedBetChooseButton,
  isUnifiedBetCouponChoiceButton,
} from './unifiedBetInteraction';

async function replyWithGenericError(interaction: Interaction, context: string, error: unknown) {
  console.error(context, error);

  if (!interaction.isRepliable()) {
    return;
  }

  const errorReply = {
    content: '명령어 실행 중 오류가 발생했습니다.',
    flags: MessageFlags.Ephemeral,
  } as const;

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(errorReply);
  } else {
    await interaction.reply(errorReply);
  }
}

export async function handleInteractionCreate(interaction: Interaction) {
  if (interaction.isButton() && isMode1BetJoinButton(interaction.customId)) {
    try {
      await handleMode1BetJoinButton(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '베팅 참가 버튼 처리 중 오류 발생', error);
    }
    return;
  }

  if (interaction.isButton() && isMode2BetChooseButton(interaction.customId)) {
    try {
      await handleMode2BetChooseButton(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '모드2 베팅 사이드 선택 처리 중 오류 발생', error);
    }
    return;
  }

  if (interaction.isModalSubmit() && isMode2BetAmountModal(interaction.customId)) {
    try {
      await handleMode2BetAmountModal(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '모드2 베팅 금액 입력 처리 중 오류 발생', error);
    }
    return;
  }

  if (interaction.isButton() && isSettlementCancelButton(interaction.customId)) {
    try {
      await handleSettlementCancelButton(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '정산취소 버튼 처리 중 오류 발생', error);
    }
    return;
  }

  if (interaction.isButton() && isUnifiedBetChooseButton(interaction.customId)) {
    try {
      await handleUnifiedBetChooseButton(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '베팅 옵션 선택 처리 중 오류 발생', error);
    }
    return;
  }

  if (interaction.isButton() && isUnifiedBetCouponChoiceButton(interaction.customId)) {
    try {
      await handleUnifiedBetCouponChoiceButton(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '베팅2배쿠폰 사용 선택 처리 중 오류 발생', error);
    }
    return;
  }

  if (interaction.isModalSubmit() && isUnifiedBetAmountModal(interaction.customId)) {
    try {
      await handleUnifiedBetAmountModal(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '베팅 금액 입력 처리 중 오류 발생', error);
    }
    return;
  }

  if (interaction.isButton() && isBlackjackActionButton(interaction.customId)) {
    try {
      await handleBlackjackActionButton(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '블랙잭 히트/스탠드 처리 중 오류 발생', error);
    }
    return;
  }

  if (interaction.isButton() && isRpsActionButton(interaction.customId)) {
    try {
      await handleRpsActionButton(interaction);
    } catch (error) {
      await replyWithGenericError(interaction, '가위바위보 버튼 처리 중 오류 발생', error);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commands.get(interaction.commandName);
  if (!command) {
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    await replyWithGenericError(interaction, `커맨드 실행 중 오류 발생: /${interaction.commandName}`, error);
  }
}
