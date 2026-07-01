import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  DISCORD_TOKEN: required('DISCORD_TOKEN'),
  DISCORD_CLIENT_ID: required('DISCORD_CLIENT_ID'),
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
  REBATE_ANNOUNCEMENT_CHANNEL_ID: process.env.REBATE_ANNOUNCEMENT_CHANNEL_ID,
  BET_LOG_CHANNEL_ID: process.env.BET_LOG_CHANNEL_ID,
  ADMIN_DISCORD_ID: process.env.ADMIN_DISCORD_ID,
  GAMBLE_ENABLED: process.env.GAMBLE_ENABLED === 'true',
  LOTTERY_CHANNEL_ID: process.env.LOTTERY_CHANNEL_ID,
};
