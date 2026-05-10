/**
 * VOX-Ads Creator — Slash Command Registration
 *
 * Registers all slash commands with Discord via the REST API.
 * Run this script manually after adding or changing commands:
 *
 *   node src/deploy-commands.js
 *
 * Do NOT call this on bot startup — it is rate-limited by Discord
 * and only needs to run when command definitions change.
 *
 * Requirements: 13.3
 */

import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID } = process.env;

if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('[deploy] Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID in environment.');
  process.exit(1);
}

// ─── Load command definitions ─────────────────────────────────────────────────

const commands = [];
const commandsPath = join(__dirname, 'commands');
const commandFiles = readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = join(commandsPath, file);
  const fileUrl = pathToFileURL(filePath).href;
  const command = await import(fileUrl);

  if (!command.data) {
    console.warn(`[deploy] Skipping ${file} — no data export`);
    continue;
  }

  commands.push(command.data.toJSON());
  console.log(`[deploy] Queued /${command.data.name}`);
}

// ─── Register with Discord ────────────────────────────────────────────────────

const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);

console.log(`[deploy] Registering ${commands.length} command(s) globally...`);

try {
  const data = await rest.put(
    Routes.applicationCommands(DISCORD_CLIENT_ID),
    { body: commands },
  );

  console.log(`[deploy] Successfully registered ${data.length} application command(s).`);
} catch (err) {
  console.error('[deploy] Failed to register commands:', err);
  process.exit(1);
}
