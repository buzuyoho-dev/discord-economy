import { REST, Routes } from 'discord.js';
import { commands } from './commands';
import { env } from './config/env';

async function deployCommands() {
  const rest = new REST().setToken(env.DISCORD_TOKEN);
  const body = [...commands.values()].map((command) => command.data.toJSON());

  const route = env.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID)
    : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

  const result = (await rest.put(route, { body })) as unknown[];
  console.log(`${result.length}개의 슬래시 커맨드를 등록했습니다.`);
}

deployCommands().catch((error) => {
  console.error('슬래시 커맨드 등록 중 오류 발생', error);
  process.exitCode = 1;
});
