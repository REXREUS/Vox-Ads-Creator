/**
 * /forget command — delete all user data stored in Discord DM.
 *
 * Clears the entire DM chat history (all bot messages), which includes
 * tagged data (BYOK_KEYS, CREDIT_LOG, VIDEO_HISTORY, ADMIN_CONFIG)
 * as well as all other bot messages (confirmations, notifications, etc.).
 *
 * Requirements: 1.5
 */

import { SlashCommandBuilder } from 'discord.js';
import { clearDMHistory } from '../modules/discordStorage.js';

export const data = new SlashCommandBuilder()
  .setName('forget')
  .setDescription('Delete all your data and chat history from bot DM');

export async function execute(interaction) {
  // Defer ephemerally — DM operations can be slow
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;

  try {
    // Delete all bot messages in the DM — covers tagged data + all other messages
    const totalDeleted = await clearDMHistory(interaction.client, userId);

    await interaction.editReply({
      content:
        `✅ **Data and chat history successfully deleted.**\n` +
        `${totalDeleted} messages were removed from your DMs.\n\n` +
        'Use `/configure` at any time to set up again.',
    });
  } catch (err) {
    console.error('[forget] Error deleting user data:', err);
    await interaction.editReply({
      content: `❌ An error occurred while deleting data: ${err.message}`,
    });
  }
}
