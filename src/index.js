/**
 * VOX-Ads Creator — Bot Entry Point
 *
 * Initializes the Discord client, loads all command handlers, routes
 * interactions (slash commands, buttons, modals, select menus), and
 * starts an Express health-check server for Railway deployment.
 *
 * Requirements: 2.1, 13.3
 */

import 'dotenv/config';
import { Client, Collection, GatewayIntentBits, Events } from 'discord.js';
import { readdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Discord Client ───────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
  ],
});

// ─── Command Collection ───────────────────────────────────────────────────────

/** @type {Collection<string, object>} */
client.commands = new Collection();

async function loadCommands() {
  const commandsPath = join(__dirname, 'commands');
  const commandFiles = readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  for (const file of commandFiles) {
    const filePath = join(commandsPath, file);
    const fileUrl = pathToFileURL(filePath).href;
    const command = await import(fileUrl);

    if (!command.data || !command.execute) {
      console.warn(`[commands] Skipping ${file} — missing data or execute export`);
      continue;
    }

    client.commands.set(command.data.name, command);
    console.log(`[commands] Loaded /${command.data.name}`);
  }
}

// ─── Interaction Router ───────────────────────────────────────────────────────

/**
 * Route an interaction to the correct command handler.
 * Tries each command's optional handler (handleButton, handleModalSubmit,
 * handleSelectMenu) until one returns true.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {'handleButton'|'handleModalSubmit'|'handleSelectMenu'} handlerName
 */
async function routeToCommands(interaction, handlerName) {
  for (const command of client.commands.values()) {
    if (typeof command[handlerName] !== 'function') continue;
    try {
      const handled = await command[handlerName](interaction);
      if (handled) return;
    } catch (err) {
      console.error(`[${handlerName}] Error in ${command.data.name}:`, err);
      // Attempt to notify the user if the interaction is still repliable
      try {
        const msg = err.message?.length > 1800 ? err.message.slice(0, 1800) + '…' : (err.message ?? 'Unknown error');
        const payload = { content: `❌ An error occurred: ${msg}`, ephemeral: true };
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(payload);
        } else {
          await interaction.reply(payload);
        }
      } catch {
        // Interaction may have already expired — ignore
      }
      return;
    }
  }
}

// ─── Event: interactionCreate ─────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) {
        console.warn(`[commands] Unknown command: ${interaction.commandName}`);
        return;
      }
      await command.execute(interaction);
      return;
    }

    if (interaction.isButton()) {
      await routeToCommands(interaction, 'handleButton');
      return;
    }

    if (interaction.isModalSubmit()) {
      await routeToCommands(interaction, 'handleModalSubmit');
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await routeToCommands(interaction, 'handleSelectMenu');
      return;
    }
  } catch (err) {
    console.error('[interactionCreate] Unhandled error:', err);
  }
});

// ─── Event: ready ─────────────────────────────────────────────────────────────

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Logged in as ${c.user.tag}`);
  console.log(`[bot] Serving ${c.guilds.cache.size} guild(s)`);
});

// ─── Health Check Server (Railway) ───────────────────────────────────────────

const app = express();

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    bot: client.isReady() ? 'online' : 'connecting',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[health] Health check server running on port ${PORT}`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

await loadCommands();
await client.login(process.env.DISCORD_BOT_TOKEN);
