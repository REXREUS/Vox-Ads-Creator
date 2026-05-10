/**
 * /myads command — display the user's video ad history from DM storage.
 *
 * Reads VIDEO_HISTORY messages from the user's DM, shows a paginated list
 * with video links, dates, and style presets. Each entry has a
 * "Reuse Storyline" button that re-opens the /ads workflow with the
 * saved storyline pre-loaded.
 *
 * Requirements: 12.1, 12.4, 12.5
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getVideoHistory } from '../modules/discordStorage.js';

// Max entries shown per page
const PAGE_SIZE = 5;

export const data = new SlashCommandBuilder()
  .setName('myads')
  .setDescription('Look at the list of advertising videos you have made')
  .addIntegerOption((opt) =>
    opt
      .setName('page')
      .setDescription('Pages (default: 1)')
      .setMinValue(1)
      .setRequired(false),
  );

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;
  const page = (interaction.options.getInteger('page') ?? 1) - 1; // 0-indexed

  try {
    const history = await getVideoHistory(interaction.client, userId);

    if (history.length === 0) {
      await interaction.editReply({
        content:
        '🎬 **No videos have been created yet.**\n' +
        'Use `/ads` to create your first video ad.',
      });
      return;
    }

    const totalPages = Math.ceil(history.length / PAGE_SIZE);
    const currentPage = Math.min(page, totalPages - 1);
    const slice = history.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    const embed = buildHistoryEmbed(slice, currentPage, totalPages, history.length);
    const components = buildComponents(slice, currentPage, totalPages);

    await interaction.editReply({ embeds: [embed], components });
  } catch (err) {
    console.error('[myads] Error reading video history:', err);
    await interaction.editReply({
      content: `❌ Failed to read video history: ${err.message}`,
    });
  }
}

// ─── Button Handler ───────────────────────────────────────────────────────────

/**
 * Handle pagination and "Reuse Storyline" button interactions.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @returns {Promise<boolean>} true if handled
 */
export async function handleButton(interaction) {
  const { customId } = interaction;

  if (customId.startsWith('myads_page_')) {
    return handlePageButton(interaction);
  }

  if (customId.startsWith('myads_reuse_')) {
    return handleReuseButton(interaction);
  }

  return false;
}

async function handlePageButton(interaction) {
  await interaction.deferUpdate();

  const userId = interaction.user.id;
  const targetPage = parseInt(interaction.customId.replace('myads_page_', ''), 10);

  try {
    const history = await getVideoHistory(interaction.client, userId);
    const totalPages = Math.ceil(history.length / PAGE_SIZE);
    const currentPage = Math.min(Math.max(targetPage, 0), totalPages - 1);
    const slice = history.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    const embed = buildHistoryEmbed(slice, currentPage, totalPages, history.length);
    const components = buildComponents(slice, currentPage, totalPages);

    await interaction.editReply({ embeds: [embed], components });
  } catch (err) {
    await interaction.editReply({ content: `❌ Failed to load page: ${err.message}`, embeds: [], components: [] });
  }

  return true;
}

async function handleReuseButton(interaction) {
  const jobId = interaction.customId.replace('myads_reuse_', '');
  const userId = interaction.user.id;

  await interaction.deferReply({ ephemeral: true });

  try {
    const history = await getVideoHistory(interaction.client, userId);
    const entry = history.find((h) => h.job_id === jobId);

    if (!entry) {
      await interaction.editReply({ content: '❌ Video not found in history.' });
      return true;
    }

    // Build a reuse summary for the user
    const date = entry.created_at
      ? new Date(entry.created_at).toLocaleDateString('id-ID', {
          day: '2-digit',
          month: 'long',
          year: 'numeric',
        })
      : 'Unknown';

    await interaction.editReply({
      content:
    `♻️ **Reuse Storyline: "${entry.title ?? 'VOX Ad'}"**\n\n` +
    `📅 Created: ${date}\n` +
    `🎨 Style: \`${entry.style ?? 'auto'}\`\n` +
    `🎞️ Scenes: ${entry.scenes ?? '?'} · Duration: ${entry.duration ?? '?'}s\n\n` +
    `To use this storyline with new assets, run \`/ads\` and use the preset style **\`${entry.style ?? 'auto'}\`** with the same concept.\n\n` +
    `> 💡 Tip: Copy the concept and style from this video into \`/ads\` for similar results with different assets.`,
    });
  } catch (err) {
    await interaction.editReply({ content: `❌ Failed to load video details: ${err.message}` });
  }

  return true;
}

// ─── Embed & Component Builders ───────────────────────────────────────────────

/**
 * Build the history embed for a page slice.
 */
function buildHistoryEmbed(slice, currentPage, totalPages, totalCount) {
  const lines = slice.map((entry, i) => {
    const date = entry.created_at
      ? new Date(entry.created_at).toLocaleDateString('id-ID', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        })
      : 'Unknown';

    const style = entry.style ?? 'auto';
    const scenes = entry.scenes ?? '?';
    const duration = entry.duration ?? '?';
    const title = entry.title ?? 'VOX Ad';

    return (
      `**${currentPage * PAGE_SIZE + i + 1}. ${title}**\n` +
      `📅 ${date} · 🎨 ${style} · 🎞️ ${scenes} scenes · ⏱️ ${duration}s`
    );
  });

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎬 My Ad Video History')
    .setDescription(lines.join('\n\n') || 'No videos.')
    .setFooter({
      text: `Page ${currentPage + 1} of ${totalPages} · Total ${totalCount} videos`,
    })
    .setTimestamp();
}

/**
 * Build action rows: "Reuse Storyline" buttons per entry + pagination row.
 */
function buildComponents(slice, currentPage, totalPages) {
  const rows = [];

  // One "Reuse Storyline" button per entry (max 5 per row, max 5 rows total)
  // Group up to 5 buttons per ActionRow
  const reuseButtons = slice.map((entry, i) =>
    new ButtonBuilder()
      .setCustomId(`myads_reuse_${entry.job_id}`)
      .setLabel(`♻️ Reuse #${currentPage * PAGE_SIZE + i + 1}`)
      .setStyle(ButtonStyle.Secondary),
  );

  // Discord allows max 5 buttons per row
  for (let i = 0; i < reuseButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(reuseButtons.slice(i, i + 5)));
  }

  // Pagination row (only if more than one page)
  if (totalPages > 1) {
    const paginationRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`myads_page_${currentPage - 1}`)
        .setLabel('◀ Previously')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId(`myads_page_${currentPage + 1}`)
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(currentPage >= totalPages - 1),
    );
    rows.push(paginationRow);
  }

  return rows;
}
