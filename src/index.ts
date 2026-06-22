import { Client, GatewayIntentBits } from 'discord.js';
import { env } from './config/env';
import { handleInteractionCreate } from './events/interactionCreate';
import { scheduleWeeklyRebate } from './jobs/weeklyRebate';

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await scheduleWeeklyRebate(client);
});

client.on('interactionCreate', handleInteractionCreate);

client.login(env.DISCORD_TOKEN);
