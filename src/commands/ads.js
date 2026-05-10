/**
 * /ads command — main workflow for VOX-Ads Creator.
 *
 * Flow:
 * 1. /ads (with attachment) → validate file → ephemeral "Fill Ad Details" button
 * 2. Button → Modal (concept, audience, age range, theme, duration+style)
 * 3. Modal submit → ephemeral settings panel (verbose toggle, watermark toggle)
 * 4. Watermark toggle → modal for watermark text input
 * 5. "Generate Storyline" → defer → BYOK keys → Gemini analysis → storyline →
 *    preview embed with Approve / Regenerate / Edit Scene buttons
 * 6. Approve → create thread → Runway scene jobs + audio in parallel →
 *    FFmpeg stitch → deliver final video
 *
 * Requirements: 2.1, 2.2, 2.3, 7.1–7.5, 8.1, 8.3, 9.3, 9.4, 5.2–5.5
 */

import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import { getKeys } from '../modules/byok.js';
import { analyzeAsset, generateStoryline, regenerateStoryline, editScene } from '../modules/geminiDirector.js';
import { uploadAsset, dispatchSceneJobs, checkDiskSpace, cleanupJobDir } from '../modules/runwayProducer.js';
import { generateBackgroundMusic, generateAllNarrations } from '../modules/audioGenerator.js';
import { stitchScenes, cleanVerboseJSON } from '../modules/outputManager.js';
import { createJobThread, createDMJobContext, updateProgress, editJobState, closeJobThread, isAtCapacity } from '../modules/queueManager.js';
import { saveToDM, appendCreditLog, readFromDM } from '../modules/discordStorage.js';
import {
  estimateCredits,
  routePipelineError,
  extractPartialResults,
  buildPartialFailureNotice,
  classifyError,
} from '../modules/errorHandler.js';
import { getPreset } from '../utils/stylePresets.js';
import { checkRateLimit, isBlacklisted } from '../modules/adminConfig.js';
import path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/quicktime', 'video/webm',
]);
const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mov', 'webm']);
const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const MAX_REGENERATIONS = 3;
const TEMP_BASE = process.env.TEMP_DIR || '/tmp/vox_jobs';

// Custom IDs
const BTN_FILL_DETAILS   = 'vox_ads_fill_details';
const MODAL_AD_DETAILS   = 'vox_ads_modal';
const INPUT_CONCEPT      = 'vox_ads_concept';
const INPUT_AUDIENCE     = 'vox_ads_audience';
const INPUT_AGE_RANGE    = 'vox_ads_age_range';
const INPUT_THEME        = 'vox_ads_theme';

const BTN_TOGGLE_VERBOSE   = 'vox_ads_toggle_verbose';
const BTN_TOGGLE_WATERMARK = 'vox_ads_toggle_watermark';
const BTN_GENERATE         = 'vox_ads_generate';
const MODAL_WATERMARK      = 'vox_ads_watermark_modal';
const INPUT_WATERMARK_TEXT = 'vox_ads_watermark_text';
const INPUT_DURATION_SCENES = 'vox_ads_duration_scenes';

const BTN_APPROVE      = 'vox_ads_approve';
const BTN_REGENERATE   = 'vox_ads_regenerate';
const BTN_EDIT_SCENE   = 'vox_ads_edit_scene';
const BTN_CANCEL_JOB   = 'vox_ads_cancel_job';
const SELECT_SCENE_PICK = 'vox_ads_scene_pick';
const MODAL_EDIT_SCENE  = 'vox_ads_edit_scene_modal';
const INPUT_SCENE_PROMPT = 'vox_ads_scene_prompt';

/**
 * Active production jobs keyed by jobId.
 * Stores AbortController so the cancel button can stop the pipeline.
 * @type {Map<string, { controller: AbortController, userId: string }>}
 */
const activeJobs = new Map();

/**
 * In-memory job state keyed by userId.
 * @type {Map<string, object>}
 */
const pendingJobs = new Map();

/** Truncate a string to fit safely in a Discord message content field. */
function truncate(str, max = 1800) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function setPendingJob(userId, data) {
  pendingJobs.set(userId, data);
  setTimeout(() => pendingJobs.delete(userId), 30 * 60 * 1000);
}

// ─── Command Definition ───────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName('ads')
  .setDescription('Create a 30-second video ad from a single product image or video')
  .addAttachmentOption((opt) =>
    opt
      .setName('asset')
      .setDescription('Product image or video (jpg, png, gif, mp4, mov, webm — max 25MB)')
      .setRequired(true),
  );

// ─── Slash Command Handler ────────────────────────────────────────────────────

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const attachment = interaction.options.getAttachment('asset');

  const ext = attachment.name.split('.').pop()?.toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return interaction.editReply({
      content: `❌ **Unsupported file format.**\nUse: jpg, png, gif, webp, mp4, mov, or webm.`,
    });
  }

  if (attachment.size > MAX_FILE_SIZE_BYTES) {
    return interaction.editReply({
      content: `❌ **File too large** (${(attachment.size / 1024 / 1024).toFixed(1)}MB).\nMaximum ${MAX_FILE_SIZE_MB}MB.`,
    });
  }

  const mimeType = attachment.contentType?.split(';')[0].trim();
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return interaction.editReply({
      content: `❌ **Invalid file type** (\`${mimeType}\`).\nUse images (jpg/png/gif/webp) or videos (mp4/mov/webm).`,
    });
  }

  const keys = await getKeys(interaction.client, interaction.user.id);
  if (!keys) {
    return interaction.editReply({
      content: `❌ **API keys not configured.**\nRun \`/configure\` first.`,
    });
  }

  // Blacklist check (req 14.5)
  if (interaction.guild && await isBlacklisted(interaction.client, interaction.guild, interaction.user.id)) {
    return interaction.editReply({
      content: `🚫 **Access denied.** You are not allowed to use \`/ads\` in this server.\nContact the server admin if you believe this is an error.`,
    });
  }

  // Rate limit check (req 14.1)
  if (interaction.guild) {
    const { allowed, used, limit } = await checkRateLimit(interaction.client, interaction.guild, interaction.user.id);
    if (!allowed) {
      return interaction.editReply({
        content: `⏱️ **Rate limit reached.** You have created **${used}/${limit}** videos in the last hour.\nTry again later.`,
      });
    }
  }

  setPendingJob(interaction.user.id, {
    attachmentUrl: attachment.url,
    attachmentName: attachment.name,
    mimeType,
    isVideo: mimeType.startsWith('video/'),
    regenCount: 0,
    verbose: false,
    watermark: null,
  });

  await interaction.editReply({
    content: `✅ **Asset received:** \`${attachment.name}\` (${(attachment.size / 1024 / 1024).toFixed(1)}MB)\n\nClick the button below to fill in your ad details.`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(BTN_FILL_DETAILS)
          .setLabel('📝 Fill Ad Details')
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  });
}

// ─── Button Handler ───────────────────────────────────────────────────────────

export async function handleButton(interaction) {
  const { customId } = interaction;
  if (customId === BTN_FILL_DETAILS)     return handleFillDetailsButton(interaction);
  if (customId === BTN_TOGGLE_VERBOSE)   return handleToggleVerbose(interaction);
  if (customId === BTN_TOGGLE_WATERMARK) return handleToggleWatermark(interaction);
  if (customId === BTN_GENERATE)         return handleGenerateButton(interaction);
  if (customId === BTN_APPROVE)          return handleApproveButton(interaction);
  if (customId.startsWith(BTN_REGENERATE)) return handleRegenerateButton(interaction);
  if (customId === BTN_EDIT_SCENE)       return handleEditSceneButton(interaction);
  if (customId.startsWith(BTN_CANCEL_JOB)) return handleCancelJobButton(interaction);
  return false;
}

/** "Fill Ad Details" button → show modal. Modal MUST be first response. */
async function handleFillDetailsButton(interaction) {
  const pending = pendingJobs.get(interaction.user.id);
  if (!pending) {
    await interaction.reply({ content: '❌ Session expired. Run `/ads` again.', ephemeral: true });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(MODAL_AD_DETAILS)
    .setTitle('VOX-Ads — Ad Details');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(INPUT_CONCEPT)
        .setLabel('Ad Concept')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Example: Showcase the product\'s strengths with a modern and elegant style')
        .setRequired(true)
        .setMaxLength(500),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(INPUT_AUDIENCE)
        .setLabel('Target Audience')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Example: Young professionals, homemakers, food lovers')
        .setRequired(true)
        .setMaxLength(200),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(INPUT_AGE_RANGE)
        .setLabel('Age Range')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Example: 18-35, 25-45, all ages')
        .setRequired(true)
        .setMaxLength(50),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(INPUT_THEME)
        .setLabel('Theme & Style (e.g. Inspirational,cinematic)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Example: Inspirational,cinematic  or  Funny,thai_comedy  or  Elegant,auto')
        .setRequired(false)
        .setMaxLength(200),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(INPUT_DURATION_SCENES)
        .setLabel('Duration (s) , Scenes — e.g. 30,6')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Format: duration,scenes — e.g. 30,6 or 15,3')
        .setRequired(true)
        .setMaxLength(10),
    ),
  );

  await interaction.showModal(modal);
  return true;
}

// ─── Modal Submit Handler ─────────────────────────────────────────────────────

export async function handleModalSubmit(interaction) {
  const { customId } = interaction;
  if (customId === MODAL_AD_DETAILS)          return handleAdDetailsModal(interaction);
  if (customId === MODAL_WATERMARK)           return handleWatermarkModal(interaction);
  if (customId.startsWith(MODAL_EDIT_SCENE))  return handleEditSceneModal(interaction);
  return false;
}

/**
 * Ad details modal submit → show settings panel (verbose + watermark toggles).
 */
async function handleAdDetailsModal(interaction) {
  const userId = interaction.user.id;
  const pending = pendingJobs.get(userId);
  if (!pending) {
    await interaction.reply({ content: '❌ Session expired. Run `/ads` again.', ephemeral: true });
    return true;
  }

  const concept        = interaction.fields.getTextInputValue(INPUT_CONCEPT).trim();
  const targetAudience = interaction.fields.getTextInputValue(INPUT_AUDIENCE).trim();
  const ageRange       = interaction.fields.getTextInputValue(INPUT_AGE_RANGE).trim();
  const themeStyleRaw  = interaction.fields.getTextInputValue(INPUT_THEME).trim();
  const durationScenesRaw = interaction.fields.getTextInputValue(INPUT_DURATION_SCENES).trim();

  // Parse theme + style from "Inspirational,cinematic" format
  const [theme = 'Inspirational', styleKey = 'auto'] = themeStyleRaw.split(',').map(s => s.trim());

  // Parse "duration,scenes" — e.g. "30,6" or just "30" (scenes defaults to 6)
  const [durPart, scenesPart] = durationScenesRaw.split(',').map(s => s.trim());
  const duration = Math.min(Math.max(parseInt(durPart, 10) || 30, 10), 60);
  const numScenes = Math.min(Math.max(parseInt(scenesPart, 10) || 6, 1), 12);

  const preset = getPreset(styleKey) ?? getPreset('auto');
  const presetParams = preset?.auto ? null : preset;

  setPendingJob(userId, {
    ...pending,
    concept, targetAudience, ageRange, theme, duration, numScenes,
    styleKey, presetParams,
    verbose: false,
    watermark: null,
  });

  await interaction.reply({
    content: buildSettingsSummary(pending.attachmentName, concept, duration, numScenes, styleKey, false, null),
    components: buildSettingsRows(false, null),
    ephemeral: true,
  });
  return true;
}

/**
 * Watermark modal submit → save watermark text, edit the existing settings panel.
 */
async function handleWatermarkModal(interaction) {
  const userId = interaction.user.id;
  const pending = pendingJobs.get(userId);
  if (!pending) {
    await interaction.reply({ content: '❌ The session has expired.', ephemeral: true });
    return true;
  }

  const watermarkText = interaction.fields.getTextInputValue(INPUT_WATERMARK_TEXT).trim();
  pending.watermark = watermarkText || null;
  setPendingJob(userId, pending);

  const newContent = buildSettingsSummary(pending.attachmentName, pending.concept, pending.duration, pending.numScenes, pending.styleKey, pending.verbose, pending.watermark);
  const newComponents = buildSettingsRows(pending.verbose, pending.watermark);

  // Try to edit the original settings panel message so the UI updates in-place.
  // Modal submits don't carry interaction.message, so we fetch it by saved ID.
  if (pending.settingsPanelMessageId) {
    try {
      const channel = interaction.channel ?? await interaction.user.createDM();
      const originalMsg = await channel.messages.fetch(pending.settingsPanelMessageId);
      await originalMsg.edit({ content: newContent, components: newComponents });
      // Acknowledge the modal interaction silently (required — must respond within 3s)
      await interaction.deferUpdate().catch(() => interaction.reply({ content: '✅ Watermark saved.', ephemeral: true }));
      return true;
    } catch {
      // Fetch/edit failed — fall through to reply
    }
  }

  // Fallback: send a new ephemeral reply with the updated panel
  await interaction.reply({
    content: newContent,
    components: newComponents,
    ephemeral: true,
  });
  return true;
}

// ─── Settings Panel Helpers ───────────────────────────────────────────────────

function buildSettingsSummary(assetName, concept, duration, numScenes, styleKey, verbose, watermark) {
  const safeAsset = (assetName ?? '').slice(0, 50);
  const safeConcept = (concept ?? '').slice(0, 100);
  const safeWatermark = watermark ? `✅ "${watermark.slice(0, 50)}"` : '❌ No';

  return (
    `📋 **Configuration Summary**\n\n` +
    `**Asset:** \`${safeAsset}\`\n` +
    `**Concept:** ${safeConcept}${concept?.length > 100 ? '...' : ''}\n` +
    `**Duration:** ${duration}s | **Scenes:** ${numScenes} | **Style:** ${styleKey}\n` +
    `**Verbose JSON:** ${verbose ? '✅ Yes' : '❌ No'}\n` +
    `**Watermark:** ${safeWatermark}\n\n` +
    `Click the button below to change the settings, then click **Generate Storyline** to continue.`
  );
}

function buildSettingsRows(verbose, watermark) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(BTN_TOGGLE_VERBOSE)
        .setLabel(verbose ? '✅ Verbose JSON' : '❌ Verbose JSON')
        .setStyle(verbose ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(BTN_TOGGLE_WATERMARK)
        .setLabel(watermark ? `✅ Watermark: "${watermark.slice(0, 15)}"` : '❌ Watermark')
        .setStyle(watermark ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(BTN_GENERATE)
        .setLabel('🚀 Generate Storyline')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

/** Toggle verbose checkbox. */
async function handleToggleVerbose(interaction) {
  const pending = pendingJobs.get(interaction.user.id);
  if (!pending) {
    await interaction.reply({ content: '❌ The session has expired.', ephemeral: true });
    return true;
  }

  pending.verbose = !pending.verbose;
  setPendingJob(interaction.user.id, pending);

  await interaction.update({
    content: buildSettingsSummary(pending.attachmentName, pending.concept, pending.duration, pending.numScenes, pending.styleKey, pending.verbose, pending.watermark),
    components: buildSettingsRows(pending.verbose, pending.watermark),
  });
  return true;
}

/** Toggle watermark — if enabling, show modal for text input. */
async function handleToggleWatermark(interaction) {
  const pending = pendingJobs.get(interaction.user.id);
  if (!pending) {
    await interaction.reply({ content: '❌ The session has expired.', ephemeral: true });
    return true;
  }

  // If watermark is currently set, disable it
  if (pending.watermark) {
    pending.watermark = null;
    setPendingJob(interaction.user.id, pending);
    await interaction.update({
      content: buildSettingsSummary(pending.attachmentName, pending.concept, pending.duration, pending.numScenes, pending.styleKey, pending.verbose, pending.watermark),
      components: buildSettingsRows(pending.verbose, pending.watermark),
    });
    return true;
  }

  // Save the settings panel message ID so we can edit it after modal submit
  pending.settingsPanelMessageId = interaction.message?.id ?? null;
  setPendingJob(interaction.user.id, pending);

  // Otherwise, show modal to input watermark text
  const modal = new ModalBuilder()
    .setCustomId(MODAL_WATERMARK)
    .setTitle('Watermark Text');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(INPUT_WATERMARK_TEXT)
        .setLabel('Teks Watermark')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Examples: Brand Name, @username, www.example.com')
        .setRequired(true)
        .setMaxLength(100),
    ),
  );

  await interaction.showModal(modal);
  return true;
}

// ─── Generate Storyline ───────────────────────────────────────────────────────

async function handleGenerateButton(interaction) {
  const userId = interaction.user.id;
  const pending = pendingJobs.get(userId);
  if (!pending?.concept) {
    await interaction.reply({ content: '❌ The session has expired. Please run `/ads` again.', ephemeral: true });
    return true;
  }

  await interaction.deferUpdate();

  await interaction.editReply({
    content: '⏳ Downloading asset and analyzing with Gemini...',
    components: [],
  });

  const keys = await getKeys(interaction.client, userId);
  if (!keys) {
    await interaction.editReply({ content: '❌ API keys not found. Run `/configure` again.' });
    return true;
  }

  // Download asset
  let assetBuffer;
  try {
    const res = await fetch(pending.attachmentUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    assetBuffer = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    await interaction.editReply({ content: `❌ Failed to download asset: ${truncate(err.message)}` });
    return true;
  }

  // Analyze with Gemini
  let assetAnalysis;
  try {
    assetAnalysis = await analyzeAsset(assetBuffer, pending.mimeType, keys.geminiKey, keys.geminiModel);
  } catch (err) {
    await interaction.editReply({ content: `❌ Gemini analysis failed: ${truncate(err.message)}` });
    return true;
  }

  await interaction.editReply({ content: '✍️ Creating a storyline...' });

  // Generate storyline
  let storyline;
  try {
    storyline = await generateStoryline(
      {
        assetBuffer,
        mimeType: pending.mimeType,
        assetAnalysis,
        concept: pending.concept,
        targetAudience: pending.targetAudience,
        ageRange: pending.ageRange,
        theme: pending.theme,
        duration: pending.duration,
        numScenes: pending.numScenes,
        stylePreset: pending.styleKey,
        watermark: !!pending.watermark,
        verbose: pending.verbose,
        presetParams: pending.presetParams,
      },
      keys.geminiKey,
      keys.geminiModel,
    );
  } catch (err) {
    if (err.code === 'CONTENT_SAFETY') {
      await interaction.editReply({ content: `🚫 **Content not permitted:** ${truncate(err.message)}` });
    } else {
      await interaction.editReply({ content: `❌ Failed to create storyline: ${truncate(err.message)}` });
    }
    return true;
  }

  setPendingJob(userId, { ...pending, assetAnalysis, storyline, regenCount: 0 });

  await sendStorylinePreview(interaction, storyline, keys.runwayModel || 'gen4.5');
  return true;
}

// ─── Storyline Preview ────────────────────────────────────────────────────────

async function sendStorylinePreview(interaction, storyline, runwayModel) {
  const totalCredits = estimateCredits(storyline, runwayModel);

  const sceneLines = storyline.scenes.map((s) =>
    `**Scene ${s.scene_id}** (${s.duration}s): ${(s.description ?? s.runway_parameters?.prompt ?? '—').slice(0, 80)}`,
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎬 Storyline Preview')
    .setDescription(
      `**${storyline.title ?? 'Video Ad'}**\n*${storyline.tagline ?? ''}*\n\n` +
      sceneLines.join('\n'),
    )
    .addFields(
      { name: 'Scenes', value: `${storyline.scenes.length}`, inline: true },
      { name: 'Total Duration', value: `${storyline.total_duration}s`, inline: true },
      { name: 'Est. Credits', value: `~${totalCredits} cr (${runwayModel})`, inline: true },
    )
    .setFooter({ text: 'Approve untuk mulai produksi • Regenerate maks 3x' });

  await interaction.editReply({
    content: '',
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(BTN_APPROVE).setLabel('✅ Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(BTN_REGENERATE).setLabel('🔄 Regenerate').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(BTN_EDIT_SCENE).setLabel('✏️ Edit Scene').setStyle(ButtonStyle.Primary),
      ),
    ],
  });
}

// ─── Regenerate Handler ───────────────────────────────────────────────────────

async function handleRegenerateButton(interaction) {
  const userId = interaction.user.id;
  const pending = pendingJobs.get(userId);

  if (!pending?.storyline) {
    await interaction.reply({ content: '❌ TThere is no active storyline. Run `/ads` again.', ephemeral: true });
    return true;
  }

  if (pending.regenCount >= MAX_REGENERATIONS) {
    await interaction.reply({
      content: `❌ The regeneration limit (${MAX_REGENERATIONS}x) has been reached. Use **✅ Approve** or **✏️ Edit Scene**.`,
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferUpdate();

  const keys = await getKeys(interaction.client, userId);
  if (!keys) {
    await interaction.editReply({ content: '❌ API keys not found. Run `/configure` again.', components: [] });
    return true;
  }

  pending.regenCount += 1;
  setPendingJob(userId, pending);

  await interaction.editReply({
    content: `⏳ Regeneration storyline (${pending.regenCount}/${MAX_REGENERATIONS})...`,
    embeds: [],
    components: [],
  });

  let newStoryline;
  try {
    // Download asset fresh — never store large buffers in pendingJobs
    const res = await fetch(pending.attachmentUrl);
    if (!res.ok) throw new Error(`Failed to download asset: HTTP ${res.status}`);
    const assetBuffer = Buffer.from(await res.arrayBuffer());

    newStoryline = await regenerateStoryline(
      {
        assetBuffer,
        mimeType: pending.mimeType,
        assetAnalysis: pending.assetAnalysis ?? '',
        concept: pending.concept,
        targetAudience: pending.targetAudience,
        ageRange: pending.ageRange,
        theme: pending.theme,
        duration: pending.duration,
        numScenes: pending.numScenes,
        stylePreset: pending.styleKey,
        watermark: !!pending.watermark,
        verbose: pending.verbose,
        presetParams: pending.presetParams,
      },
      `${pending.regenCount}th regeneration. Create a different variation than before.`,
      keys.geminiKey,
      keys.geminiModel,
    );
  } catch (err) {
    await interaction.editReply({ content: `❌ Regeneration failed: ${truncate(err.message)}`, components: [] });
    return true;
  }

  pending.storyline = newStoryline;
  setPendingJob(userId, pending);

  await sendStorylinePreview(interaction, newStoryline, keys.runwayModel || 'gen4.5');
  return true;
}

// ─── Edit Scene Handlers ──────────────────────────────────────────────────────

async function handleEditSceneButton(interaction) {
  const pending = pendingJobs.get(interaction.user.id);
  if (!pending?.storyline) {
    await interaction.reply({ content: '❌ There is no active storyline.', ephemeral: true });
    return true;
  }

  const options = pending.storyline.scenes.map((s) => ({
    label: `Scene ${s.scene_id} (${s.duration}s)`,
    description: (s.description ?? s.runway_parameters?.prompt ?? '').slice(0, 100),
    value: String(s.scene_id),
  }));

  await interaction.reply({
    content: '✏️ Select the scene you want to edit:',
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(SELECT_SCENE_PICK)
          .setPlaceholder('Select scene...')
          .addOptions(options),
      ),
    ],
    ephemeral: true,
  });
  return true;
}

export async function handleSelectMenu(interaction) {
  if (interaction.customId === SELECT_SCENE_PICK) return handleScenePickSelect(interaction);
  return false;
}

async function handleScenePickSelect(interaction) {
  const sceneId = parseInt(interaction.values[0], 10);
  const pending = pendingJobs.get(interaction.user.id);
  if (!pending?.storyline) {
    await interaction.reply({ content: '❌ The session has expired.', ephemeral: true });
    return true;
  }

  const scene = pending.storyline.scenes.find((s) => s.scene_id === sceneId);
  if (!scene) {
    await interaction.reply({ content: `❌ Scene ${sceneId} not found.`, ephemeral: true });
    return true;
  }

  const currentPrompt = scene.runway_parameters?.prompt ?? scene.description ?? '';

  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_EDIT_SCENE}_${sceneId}`)
    .setTitle(`Edit Scene ${sceneId}`);

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(INPUT_SCENE_PROMPT)
        .setLabel(`Prompt Scene ${sceneId}`)
        .setStyle(TextInputStyle.Paragraph)
        .setValue(currentPrompt.slice(0, 4000))
        .setRequired(true)
        .setMaxLength(4000),
    ),
  );

  await interaction.showModal(modal);
  return true;
}

async function handleEditSceneModal(interaction) {
  const sceneId = parseInt(interaction.customId.replace(`${MODAL_EDIT_SCENE}_`, ''), 10);
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;
  const pending = pendingJobs.get(userId);
  if (!pending?.storyline) {
    await interaction.editReply({ content: '❌ The session has expired. Please run `/ads` again.' });
    return true;
  }

  const newPrompt = interaction.fields.getTextInputValue(INPUT_SCENE_PROMPT).trim();
  const keys = await getKeys(interaction.client, userId);
  if (!keys) {
    await interaction.editReply({ content: '❌ API keys not found.' });
    return true;
  }

  let updatedStoryline;
  try {
    updatedStoryline = await editScene(pending.storyline, sceneId, { prompt: newPrompt }, keys.geminiKey, keys.geminiModel);
  } catch (err) {
    await interaction.editReply({ content: `❌ Failed to edit scene: ${truncate(err.message)}` });
    return true;
  }

  pending.storyline = updatedStoryline;
  setPendingJob(userId, pending);

  await sendStorylinePreview(interaction, updatedStoryline, keys.runwayModel || 'gen4.5');
  return true;
}

// ─── Showcase Helper ──────────────────────────────────────────────────────────

/**
 * Post the completed video to the showcase channel if one is configured.
 * Reads ADMIN_CONFIG from the bot owner's DM to find the showcase channel ID.
 * A video is "showcase eligible" if it has 4+ scenes and a non-auto style preset.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {import('discord.js').EmbedBuilder} embed
 * @param {import('discord.js').AttachmentBuilder} videoFile
 * @param {object} storyline
 * @param {string} userId
 */
async function postToShowcaseIfEligible(interaction, embed, videoFile, storyline, userId) {
  try {
    // Read admin config — stored by /setshowcase command under the guild's admin
    // We look for ADMIN_CONFIG in the bot's own DM with the guild owner
    const guild = interaction.guild;
    if (!guild) return;

    const ownerId = guild.ownerId;
    const adminConfig = await readFromDM(interaction.client, ownerId, 'ADMIN_CONFIG').catch(() => null);
    if (!adminConfig?.showcase_channel_id) return;

    const showcaseChannel = await guild.channels.fetch(adminConfig.showcase_channel_id).catch(() => null);
    if (!showcaseChannel?.isTextBased()) return;

    // Eligibility: 4+ scenes and a named style preset (not auto)
    const isEligible = storyline.scenes.length >= 4;
    if (!isEligible) return;

    const showcaseEmbed = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle('✨ Featured Ad')
      .setDescription(embed.data.description ?? '')
      .addFields(...(embed.data.fields ?? []))
      .setFooter({ text: `Created by a community member` })
      .setTimestamp();

    await showcaseChannel.send({ embeds: [showcaseEmbed], files: [videoFile] });
    console.log(`[ads] Posted job to showcase channel ${adminConfig.showcase_channel_id}`);
  } catch (err) {
    // Showcase posting is non-fatal
    console.warn(`[ads] Showcase posting failed (non-fatal): ${err.message}`);
  }
}


// ─── Cancel Job Handler ───────────────────────────────────────────────────────

async function handleCancelJobButton(interaction) {
  // customId format: vox_ads_cancel_job_<jobId>
  const jobId = interaction.customId.replace(`${BTN_CANCEL_JOB}_`, '');
  const job = activeJobs.get(jobId);

  if (!job) {
    await interaction.reply({
      content: '⚠️ Job not found or already finished.',
      ephemeral: true,
    });
    return true;
  }

  // Only the job owner can cancel
  if (job.userId !== interaction.user.id) {
    await interaction.reply({
      content: '❌ Only the person who started this job can cancel it.',
      ephemeral: true,
    });
    return true;
  }

  job.controller.abort();
  activeJobs.delete(jobId);

  await interaction.update({
    content: '🛑 **Cancellation requested.** Stopping production and cleaning up...',
    components: [],
  });
  return true;
}

async function handleApproveButton(interaction) {
  const userId = interaction.user.id;
  const pending = pendingJobs.get(userId);

  if (!pending?.storyline) {
    await interaction.reply({ content: '❌ There are no active storylines. Run `/ads` again.', ephemeral: true });
    return true;
  }

  const inGuild = !!interaction.guild;

  if (inGuild && await isAtCapacity(interaction.guild)) {
    await interaction.reply({
      content: '⏳ **The server is currently full.** All production slots are in use. Please try again in a few minutes.',
      ephemeral: true,
    });
    return true;
  }

  try {
    await checkDiskSpace();
  } catch (err) {
    await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    return true;
  }

  const keys = await getKeys(interaction.client, userId);
  if (!keys) {
    await interaction.reply({ content: '❌ API keys not found. Run `/configure` again.', ephemeral: true });
    return true;
  }

  const runwayModel = keys.runwayModel || 'gen4.5';
  const estimatedCredits = estimateCredits(pending.storyline, runwayModel);

  const progressNote = inGuild
    ? 'Check the thread created in this channel for progress.'
    : 'Progress updates will be sent here in DM.';

  await interaction.update({
    content:
      `🚀 **Production begins!**\n` +
      `Estimated credits: ~**${estimatedCredits}** (${runwayModel})\n` +
      progressNote,
    embeds: [],
    components: [],
  });

  const jobData = { ...pending };
  pendingJobs.delete(userId);

  // Create job context — thread in guild, DM channel pseudo-thread in DM
  let thread, stateMessageId;
  if (inGuild) {
    ({ thread, stateMessageId } = await createJobThread(interaction.channel, userId, {
      status: 'uploading',
      style: jobData.styleKey,
      scenes_total: jobData.storyline.scenes.length,
      scenes_completed: [],
      scenes_pending: jobData.storyline.scenes.map((s) => s.scene_id),
      scenes_failed: [],
    }));
  } else {
    const dmChannel = await interaction.user.createDM();
    ({ thread, stateMessageId } = await createDMJobContext(dmChannel, userId, {
      status: 'uploading',
      style: jobData.styleKey,
      scenes_total: jobData.storyline.scenes.length,
      scenes_completed: [],
      scenes_pending: jobData.storyline.scenes.map((s) => s.scene_id),
      scenes_failed: [],
    }));
  }

  const jobId = inGuild ? thread.id : `${userId}_${Date.now()}`;

  // Register job with an AbortController so the cancel button can stop it
  const controller = new AbortController();
  activeJobs.set(jobId, { controller, userId });

  // Post a cancel button to the job thread so the user can stop production
  const cancelRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BTN_CANCEL_JOB}_${jobId}`)
      .setLabel('🛑 Cancel Job')
      .setStyle(ButtonStyle.Danger),
  );
  const cancelEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setDescription('⚙️ **Production started.**\nProgress updates will appear below.');
  await thread.send({ embeds: [cancelEmbed], components: [cancelRow] });

  runProductionPipeline({ interaction, thread, stateMessageId, jobId, jobData, keys, userId, inGuild, signal: controller.signal }).catch((err) => {
    console.error(`[ads] Unhandled pipeline error for job ${jobId}:`, err);
  });

  return true;
}

async function runProductionPipeline({ interaction, thread, stateMessageId, jobId, jobData, keys, userId, inGuild = true, signal }) {
  const { attachmentUrl, mimeType, isVideo, storyline, watermark, verbose } = jobData;
  const outputPath = path.join(TEMP_BASE, jobId, 'final.mp4');

  // Track credit usage
  let runwayCreditsUsed = 0;
  let geminiTokensUsed = 0;
  const completedSceneIds = [];

  /** Throw if the user cancelled the job. */
  function checkCancelled() {
    if (signal?.aborted) {
      const err = new Error('Job cancelled by user.');
      err.code = 'JOB_CANCELLED';
      throw err;
    }
  }

  try {
    checkCancelled();
    await updateProgress(thread, '📤 Downloading and uploading assets to Runway...');

    // Download asset fresh — never store large buffers in memory between steps
    const assetRes = await fetch(attachmentUrl);
    if (!assetRes.ok) throw new Error(`Failed to download asset: HTTP ${assetRes.status}`);
    const assetBuffer = Buffer.from(await assetRes.arrayBuffer());

    const assetRunwayUri = await uploadAsset(assetBuffer, mimeType, keys.runwayKey);

    checkCancelled();
    await updateProgress(thread, `🎬 Processing ${storyline.scenes.length} scenes sequentially (chained for visual continuity)...`);

    const audioMood = storyline.audio_mood ?? storyline.scenes[0]?.audio_mood ?? 'Upbeat background music';
    const runwayModel = keys.runwayModel || 'gen4.5';
    const narrationVoice = storyline.narration_voice ?? 'Eleanor';

    // Dispatch scenes + audio + narrations all in parallel
    let clipPaths;
    let partialFailureNotice = null;

    const [sceneResult, audioPath, narrationPaths] = await Promise.all([
      dispatchSceneJobs(storyline, keys.runwayKey, assetRunwayUri, jobId, {
        isVideo,
        signal,
        onSceneDone: (sceneId, total) => {
          completedSceneIds.push(sceneId);
          updateProgress(thread, `✅ Scene ${sceneId}/${total} done${sceneId < total ? ' → chaining to next scene...' : ''}`).catch(() => {});
          editJobState(thread, stateMessageId, {
            status: 'processing',
            scenes_completed: [...completedSceneIds],
            scenes_pending: storyline.scenes.map((s) => s.scene_id).filter((id) => !completedSceneIds.includes(id)),
          }).catch(() => {});
        },
      }).catch((err) => {
        if (err.code === 'PARTIAL_FAILURE') {
          const { clipPaths: partial, failedScenes } = extractPartialResults(err);
          partialFailureNotice = buildPartialFailureNotice(failedScenes);
          err.succeededScenes?.forEach((s) => {
            if (!completedSceneIds.includes(s.sceneId)) completedSceneIds.push(s.sceneId);
          });
          return partial;
        }
        throw err;
      }),
      generateBackgroundMusic(audioMood, keys.runwayKey, jobId).catch((err) => {
        console.warn(`[ads] Audio generation failed (non-fatal): ${err.message}`);
        return null;
      }),
      generateAllNarrations(storyline.scenes, narrationVoice, keys.runwayKey, jobId).catch((err) => {
        console.warn(`[ads] Narration generation failed (non-fatal): ${err.message}`);
        return null;
      }),
    ]);

    clipPaths = sceneResult;

    checkCancelled();

    // Calculate credit usage (approximate)
    const creditRates = { 'gen4.5': 12, 'gen4_turbo': 5, 'seedance2': 36, 'gen4_aleph': 15 };
    const ratePerSec = creditRates[runwayModel] ?? 12;
    runwayCreditsUsed = storyline.scenes.reduce((sum, s) => sum + (s.duration || 5) * ratePerSec, 0);
    if (audioPath) runwayCreditsUsed += 2;

    await updateProgress(thread, '🎞️ Bringing together scenes and audio...');
    const finalPath = await stitchScenes(clipPaths, storyline, {
      outputPath,
      watermark: watermark || undefined,
      audioPath: audioPath || undefined,
      narrationPaths: narrationPaths || undefined,
      isVideoInput: isVideo,
    });

    await updateProgress(thread, '📦 Sending final video...');
    const videoFile = new AttachmentBuilder(finalPath, { name: 'vox_ad.mp4' });

    const deliveryEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🎉 Advertisement Video Complete!')
      .setDescription(`**${storyline.title ?? 'VOX Ad'}**\n*${storyline.tagline ?? ''}*`)
      .addFields(
        { name: 'Scenes', value: `${storyline.scenes.length}`, inline: true },
        { name: 'Duration', value: `${storyline.total_duration}s`, inline: true },
        { name: 'Style', value: jobData.styleKey, inline: true },
      )
      .setTimestamp();

    // Deliver to guild channel or DM depending on context
    const deliveryChannel = inGuild ? interaction.channel : await interaction.user.createDM();
    await deliveryChannel.send({ embeds: [deliveryEmbed], files: [videoFile] });

    if (partialFailureNotice) {
      await deliveryChannel.send(partialFailureNotice);
    }

    // Verbose JSON output
    if (verbose) {
      const cleanJSON = cleanVerboseJSON(storyline);
      const jsonStr = JSON.stringify(cleanJSON, null, 2);
      if (jsonStr.length <= 1990) {
        await deliveryChannel.send(`\`\`\`json\n${jsonStr}\n\`\`\``);
      } else {
        const jsonFile = new AttachmentBuilder(Buffer.from(jsonStr), { name: 'storyline.json' });
        await deliveryChannel.send({ content: '📄 Storyline JSON:', files: [jsonFile] });
      }
    }

    // Save video history to user DM
    const historyEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('📼 Video Saved to History')
      .setDescription(`**${storyline.title ?? 'VOX Ad'}**\n*${storyline.tagline ?? ''}*`)
      .addFields(
        { name: '🎞️ Scenes', value: `${storyline.scenes.length}`, inline: true },
        { name: '⏱️ Duration', value: `${storyline.total_duration}s`, inline: true },
        { name: '🎨 Style', value: jobData.styleKey, inline: true },
      )
      .setTimestamp()
      .setFooter({ text: 'VOX-Ads · Use /myads to view your history' });
    await saveToDM(interaction.client, userId, 'VIDEO_HISTORY', {
      job_id: jobId,
      title: storyline.title ?? 'VOX Ad',
      scenes: storyline.scenes.length,
      duration: storyline.total_duration,
      style: jobData.styleKey,
      created_at: new Date().toISOString(),
    }, historyEmbed).catch((err) => {
      console.warn(`[ads] Failed to save video history: ${err.message}`);
    });

    // Log credit usage to user DM
    await appendCreditLog(interaction.client, userId, {
      job_id: jobId,
      runway_credits_used: runwayCreditsUsed,
      gemini_tokens_used: geminiTokensUsed,
      scenes_processed: completedSceneIds.length,
      runway_model: runwayModel,
      status: partialFailureNotice ? 'partial' : 'completed',
    }).catch((err) => {
      console.warn(`[ads] Failed to log credits: ${err.message}`);
    });

    // Post to showcase channel if eligible (guild only)
    if (inGuild) {
      await postToShowcaseIfEligible(interaction, deliveryEmbed, videoFile, storyline, userId);
    }

    await closeJobThread(thread, '✅ Job completed. Thread archived.');
  } catch (err) {
    console.error(`[ads] Production pipeline error (job ${jobId}):`, err);

    // Handle user-initiated cancellation
    if (err.code === 'JOB_CANCELLED') {
      await updateProgress(thread, '🛑 **Job cancelled by user.** Cleaning up...').catch(() => {});
      await closeJobThread(thread, '🛑 Job cancelled. Thread archived.').catch(() => {});
      return;
    }

    const runwayModel = keys.runwayModel || 'gen4.5';

    // Route to specific critical failure handler
    const handled = await routePipelineError({
      client: interaction.client,
      userId,
      thread,
      stateMessageId,
      jobId,
      err,
      storyline,
      completedScenes: completedSceneIds,
      runwayModel,
      runwayCreditsUsed,
      geminiTokensUsed,
    });

    if (!handled) {
      // Generic fallback — update thread and notify user
      const classified = classifyError(err);

      // Build a user-friendly error message — hide raw tracebacks
      let userFacingMsg;
      if (err.code === 'FFMPEG_WORKER_ERROR') {
        userFacingMsg = '❌ **Post-production failed.** The video rendering step encountered an error. Please try again or contact support if the issue persists.';
      } else {
        userFacingMsg = `❌ **Production failed.** ${classified?.message || 'An unexpected error occurred. Please try again.'}`;
      }

      const errMsg = userFacingMsg;

      await updateProgress(thread, errMsg).catch(() => {});
      await closeJobThread(thread, '❌ Job failed. Thread archived.').catch(() => {});

      // Log failed job to credit history if any credits were used
      if (runwayCreditsUsed > 0) {
        await appendCreditLog(interaction.client, userId, {
          job_id: jobId,
          runway_credits_used: runwayCreditsUsed,
          gemini_tokens_used: geminiTokensUsed,
          scenes_processed: completedSceneIds.length,
          runway_model: runwayModel,
          status: 'failed',
        }).catch(() => {});
      }

      try {
        await interaction.followUp({ content: errMsg, ephemeral: true });
      } catch {
        // Interaction may have expired
      }
    }
  } finally {
    activeJobs.delete(jobId);
    await cleanupJobDir(jobId);
  }
}
