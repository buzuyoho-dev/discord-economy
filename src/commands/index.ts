import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import * as adminGrant from './adminGrant';
import * as balance from './balance';
import * as checkin from './checkin';
import * as couponList from './couponList';
import * as economyConfigSet from './economyConfigSet';
import * as economyConfigView from './economyConfigView';
import * as gamble from './gamble';
import * as gambleExtraPurchase from './gambleExtraPurchase';
import * as house from './house';
import * as lotteryBuy from './lotteryBuy';
import * as loanCreate from './loanCreate';
import * as loanRepay from './loanRepay';
import * as mode1BetClose from './mode1BetClose';
import * as mode1BetCreate from './mode1BetCreate';
import * as mode1BetSettle from './mode1BetSettle';
import * as mode2BetClose from './mode2BetClose';
import * as mode2BetSettle from './mode2BetSettle';
import * as ranking from './ranking';
import * as settlementCancel from './settlementCancel';
import * as transfer from './transfer';

export interface Command {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

export const commands = new Map<string, Command>([
  [adminGrant.data.name, adminGrant],
  [balance.data.name, balance],
  [checkin.data.name, checkin],
  [gamble.data.name, gamble],
  [gambleExtraPurchase.data.name, gambleExtraPurchase],
  [house.data.name, house],
  [lotteryBuy.data.name, lotteryBuy],
  [mode1BetCreate.data.name, mode1BetCreate],
  [mode1BetClose.data.name, mode1BetClose],
  [mode1BetSettle.data.name, mode1BetSettle],
  [mode2BetClose.data.name, mode2BetClose],
  [mode2BetSettle.data.name, mode2BetSettle],
  [transfer.data.name, transfer],
  [loanCreate.data.name, loanCreate],
  [loanRepay.data.name, loanRepay],
  [ranking.data.name, ranking],
  [settlementCancel.data.name, settlementCancel],
  [economyConfigSet.data.name, economyConfigSet],
  [economyConfigView.data.name, economyConfigView],
  [couponList.data.name, couponList],
]);
