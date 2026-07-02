import { Client, GatewayIntentBits } from 'discord.js';
import { env } from './config/env';
import { handleInteractionCreate } from './events/interactionCreate';
import { scheduleLotteryDraw } from './jobs/lotteryDraw';
import { scheduleWeeklyDistribution } from './jobs/weeklyDistribution';

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await scheduleWeeklyDistribution(client);
  await scheduleLotteryDraw(client);
});

client.on('interactionCreate', handleInteractionCreate);

client.login(env.DISCORD_TOKEN);
