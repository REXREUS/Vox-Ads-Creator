/**
 * /setratelimit command — admin configures per-user rate limits and whitelist/blacklist.
 *
 * Saves rate limit config and user lists to the admin's DM with vox_type: "ADMIN_CONFIG".
 * Only users with ManageGuild permission can run this.
 *
 * Subcommands:
 *   /setratelimit set <videos_per_hour>   — set max videos per user per hour
 *   /setratelimit whitelist <user>        — add user to whitelist (bypass rate limit)
 *   /setratelimit blacklist <user>        — add user to blacklist (block from /ads)
 *   /setratelimit remove <user>           — remove user from whitelist or blacklist
 *   /setratelimit status                  — show current config
 *
 * Requirements: 14.1, 14.4, 14.5
 */

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} from 'discord.js';
import { readFromDM, saveToDM, deleteFromDM } from '../modules/discordStorage.js';

const VOX_TYPE = 'ADMIN_CONFIG';
const DEFAULT_RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_HOUR ?? '3', 10);

export const data = new SlashCommandBuilder()
  .setName('setratelimit')
  .setDescription('Admin: Configure rate limits and user whitelist/blacklist')
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Set maximum videos per user per hour')
      .addIntegerOption((opt) =>
        opt
          .setName('videos_per_hour')
          .setDescription('Maximum number of videos per user per hour (1–20)')
          .setMinValue(1)
          .setMaxValue(20)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('whitelist')
      .setDescription('Add user to whitelist (bypass rate limit)')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Users to be whitelisted').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('blacklist')
      .setDescription('Add user to blacklist (block from /ads)')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Users who will be blacklisted').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove user from whitelist or blacklist')
      .addUserOption((opt) =>
        opt.setName('user').setDescription('Users to be removed from the list').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show current rate limit configuration'),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: '❌ This command can only be used on Discord servers.' });
    return;
  }

  // Always read/write config from guild owner's DM — consistent with adminConfig.js
  const configUserId = guild.ownerId;
  const subcommand = interaction.options.getSubcommand();

  try {
    const existing = await readFromDM(interaction.client, configUserId, VOX_TYPE).catch(() => null);
    const config = buildConfig(existing);

    switch (subcommand) {
      case 'set':
        await handleSet(interaction, configUserId, config);
        break;
      case 'whitelist':
        await handleWhitelist(interaction, configUserId, config);
        break;
      case 'blacklist':
        await handleBlacklist(interaction, configUserId, config);
        break;
      case 'remove':
        await handleRemove(interaction, configUserId, config);
        break;
      case 'status':
        await handleStatus(interaction, config);
        break;
      default:
        await interaction.editReply({ content: '❌ Unknown subcommand.' });
    }
  } catch (err) {
    console.error('[setratelimit] Error:', err);
    await interaction.editReply({ content: `❌ Failed to update configuration: ${err.message}` });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a clean config object from existing DM data, with defaults.
 */
function buildConfig(existing) {
  return {
    guild_id: existing?.guild_id ?? null,
    showcase_channel_id: existing?.showcase_channel_id ?? null,
    rate_limit_per_hour: existing?.rate_limit_per_hour ?? DEFAULT_RATE_LIMIT,
    whitelist: existing?.whitelist ?? [],
    blacklist: existing?.blacklist ?? [],
  };
}

/**
 * Persist config to admin DM, replacing the old ADMIN_CONFIG message.
 */
async function saveConfig(client, adminUserId, config) {
  await deleteFromDM(client, adminUserId, VOX_TYPE);
  await saveToDM(client, adminUserId, VOX_TYPE, config);
}

async function handleSet(interaction, adminUserId, config) {
  const videosPerHour = interaction.options.getInteger('videos_per_hour');
  config.rate_limit_per_hour = videosPerHour;
  await saveConfig(interaction.client, adminUserId, config);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Rate Limit Diperbarui')
        .setDescription(`Maksimal **${videosPerHour} video per jam** per user.`)
        .setTimestamp(),
    ],
  });
}

async function handleWhitelist(interaction, adminUserId, config) {
  const target = interaction.options.getUser('user');

  // Remove from blacklist if present
  config.blacklist = config.blacklist.filter((id) => id !== target.id);

  if (!config.whitelist.includes(target.id)) {
    config.whitelist.push(target.id);
  }

  await saveConfig(interaction.client, adminUserId, config);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ User Di-whitelist')
        .setDescription(`<@${target.id}> dapat bypass rate limit dan menggunakan \`/ads\` tanpa batasan.`)
        .setTimestamp(),
    ],
  });
}

async function handleBlacklist(interaction, adminUserId, config) {
  const target = interaction.options.getUser('user');

  // Remove from whitelist if present
  config.whitelist = config.whitelist.filter((id) => id !== target.id);

  if (!config.blacklist.includes(target.id)) {
    config.blacklist.push(target.id);
  }

  await saveConfig(interaction.client, adminUserId, config);

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🚫 User Di-blacklist')
        .setDescription(`<@${target.id}> tidak dapat menggunakan \`/ads\` di server ini.`)
        .setTimestamp(),
    ],
  });
}

async function handleRemove(interaction, adminUserId, config) {
  const target = interaction.options.getUser('user');

  const wasWhitelisted = config.whitelist.includes(target.id);
  const wasBlacklisted = config.blacklist.includes(target.id);

  config.whitelist = config.whitelist.filter((id) => id !== target.id);
  config.blacklist = config.blacklist.filter((id) => id !== target.id);

  if (!wasWhitelisted && !wasBlacklisted) {
    await interaction.editReply({
      content: `ℹ️ <@${target.id}> tidak ada di whitelist maupun blacklist.`,
    });
    return;
  }

  await saveConfig(interaction.client, adminUserId, config);

  const removedFrom = wasWhitelisted ? 'whitelist' : 'blacklist';
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('✅ User Dihapus dari List')
        .setDescription(`<@${target.id}> telah dihapus dari **${removedFrom}**.`)
        .setTimestamp(),
    ],
  });
}

async function handleStatus(interaction, config) {
  const whitelistDisplay =
    config.whitelist.length > 0
      ? config.whitelist.map((id) => `<@${id}>`).join(', ')
      : '_Tidak ada_';

  const blacklistDisplay =
    config.blacklist.length > 0
      ? config.blacklist.map((id) => `<@${id}>`).join(', ')
      : '_Tidak ada_';

  const showcaseDisplay = config.showcase_channel_id
    ? `<#${config.showcase_channel_id}>`
    : '_Belum dikonfigurasi_';

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('⚙️ Konfigurasi Admin VOX-Ads')
    .addFields(
      {
        name: '⏱️ Rate Limit',
        value: `**${config.rate_limit_per_hour}** video per jam per user`,
        inline: false,
      },
      { name: '✨ Showcase Channel', value: showcaseDisplay, inline: false },
      { name: '✅ Whitelist', value: whitelistDisplay, inline: true },
      { name: '🚫 Blacklist', value: blacklistDisplay, inline: true },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
