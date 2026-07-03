import { Client, GatewayIntentBits } from 'discord.js';
import { env } from './config/env';
import { handleInteractionCreate } from './events/interactionCreate';
import { scheduleDistributionBatch } from './jobs/distributionBatch';
import { scheduleLotteryDraw } from './jobs/lotteryDraw';

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await scheduleDistributionBatch(client);
  await scheduleLotteryDraw(client);
});

client.on('interactionCreate', handleInteractionCreate);

client.login(env.DISCORD_TOKEN);
