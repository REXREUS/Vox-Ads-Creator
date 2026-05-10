/**
 * /setshowcase command — admin sets the showcase channel for auto-posting.
 *
 * Saves showcase_channel_id to the guild owner's DM with vox_type: "ADMIN_CONFIG".
 * Only the guild owner (or users with ManageGuild permission) can run this.
 *
 * Requirements: 14.2, 17.1
 */

import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} from 'discord.js';
import { readFromDM, saveToDM, deleteFromDM } from '../modules/discordStorage.js';

const VOX_TYPE = 'ADMIN_CONFIG';

export const data = new SlashCommandBuilder()
  .setName('setshowcase')
  .setDescription('Admin: Set channel showcase to automatically show the best videos.')
  .addChannelOption((opt) =>
    opt
      .setName('channel')
      .setDescription('Text channel for video showcase (leave blank to disable)')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(false),
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
  const channelOption = interaction.options.getChannel('channel');

  try {
    const existing = await readFromDM(interaction.client, configUserId, VOX_TYPE).catch(() => null);

    if (!channelOption) {
      // Disable showcase
      if (!existing?.showcase_channel_id) {
        await interaction.editReply({ content: 'ℹ️ Showcase channel is not configured yet.' });
        return;
      }

      await deleteFromDM(interaction.client, configUserId, VOX_TYPE);
      const updated = { ...existing };
      delete updated.showcase_channel_id;
      delete updated.vox_type;
      delete updated.version;
      delete updated.timestamp;

      if (Object.keys(updated).length > 0) {
        await saveToDM(interaction.client, configUserId, VOX_TYPE, updated);
      }

      await interaction.editReply({ content: '✅ Showcase channel has been disabled.' });
      return;
    }

    const mergedConfig = {
      ...(existing ?? {}),
      guild_id: guild.id,
      showcase_channel_id: channelOption.id,
    };

    delete mergedConfig.vox_type;
    delete mergedConfig.version;
    delete mergedConfig.timestamp;

    await deleteFromDM(interaction.client, configUserId, VOX_TYPE);
    await saveToDM(interaction.client, configUserId, VOX_TYPE, mergedConfig);

    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('✅ Showcase Channel Configured')
      .addFields(
        { name: 'Channel', value: `<#${channelOption.id}>`, inline: true },
        { name: 'Guild', value: guild.name, inline: true },
      )
      .setDescription(
        'Eligible ad videos (4+ scenes) will be automatically posted to this channel.',
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[setshowcase] Error:', err);
    await interaction.editReply({ content: `❌ Failed to save configuration: ${err.message}` });
  }
}
