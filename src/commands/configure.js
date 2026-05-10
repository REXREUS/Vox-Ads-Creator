/**
 * /configure command — BYOK setup flow.
 *
 * Flow:
 * 1. /configure → ephemeral message with "Open Config" button
 * 2. Button click → Modal (Gemini API Key + Runway API Key)
 * 3. Modal submit → ephemeral message with two StringSelectMenus (model selection)
 * 4. Both selects submitted → validate keys → save to DM → ephemeral confirmation
 *
 * Note: Modals only support TextInput components, so model selection is done
 * via a follow-up ephemeral message with StringSelectMenus after the modal.
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
} from 'discord.js';
import { saveKeys, validateKeys } from '../modules/byok.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_MODELS = [
  { label: 'gemini-2.5-flash (Default — Fast)', value: 'gemini-2.5-flash', default: true },
  { label: 'gemini-2.5-pro (High Quality)', value: 'gemini-2.5-pro' },
  { label: 'gemini-3-flash-preview (Latest Fast)', value: 'gemini-3-flash-preview' },
  { label: 'gemini-3.1-pro-preview (Latest Pro)', value: 'gemini-3.1-pro-preview' },
];

const RUNWAY_MODELS = [
  { label: 'gen4.5 (Default — General Purpose, 12 cr/s)', value: 'gen4.5', default: true },
  { label: 'gen4_turbo (Fast & Budget, 5 cr/s)', value: 'gen4_turbo' },
  { label: 'seedance2 (Video Input / Long Duration, 36 cr/s)', value: 'seedance2' },
  { label: 'gen4_aleph (Video Style Transform, 15 cr/s)', value: 'gen4_aleph' },
];

// Custom IDs
const BTN_OPEN_CONFIG = 'vox_configure_open';
const BTN_SAVE_CONFIG = 'vox_configure_save';
const MODAL_CONFIG = 'vox_configure_modal';
const INPUT_GEMINI_KEY = 'vox_gemini_key';
const INPUT_RUNWAY_KEY = 'vox_runway_key';
const SELECT_GEMINI_MODEL = 'vox_select_gemini_model';
const SELECT_RUNWAY_MODEL = 'vox_select_runway_model';

// In-memory store for keys collected from modal, keyed by userId.
// Cleared after successful save or timeout.
const pendingKeys = new Map();

// ─── Command Definition ────────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName('configure')
  .setDescription('Store your API keys (Gemini + Runway) securely in a private DM');

// ─── Slash Command Handler ─────────────────────────────────────────────────────

export async function execute(interaction) {
  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_OPEN_CONFIG)
      .setLabel('⚙️ Open Config')
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({
    content: '**VOX-Ads Configuration**\nClick the button below to enter your API keys. All data is stored encrypted in your private DM.',
    components: [buttonRow],
    ephemeral: true,
  });
}

// ─── Button Handler ────────────────────────────────────────────────────────────

/**
 * Handle the "Open Config" button — show the API key modal.
 * Modal MUST be the first and only response to a button interaction.
 */
export async function handleButton(interaction) {
  if (interaction.customId === BTN_OPEN_CONFIG) {
    const modal = new ModalBuilder()
      .setCustomId(MODAL_CONFIG)
      .setTitle('VOX-Ads API Configuration');

    const geminiKeyInput = new TextInputBuilder()
      .setCustomId(INPUT_GEMINI_KEY)
      .setLabel('Gemini API Key')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('AIza...')
      .setRequired(true)
      .setMinLength(20);

    const runwayKeyInput = new TextInputBuilder()
      .setCustomId(INPUT_RUNWAY_KEY)
      .setLabel('Runway API Key')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('key_...')
      .setRequired(true)
      .setMinLength(10);

    modal.addComponents(
      new ActionRowBuilder().addComponents(geminiKeyInput),
      new ActionRowBuilder().addComponents(runwayKeyInput),
    );

    // showModal must be the FIRST response — no defer before this
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.customId === BTN_SAVE_CONFIG) {
    const pending = pendingKeys.get(interaction.user.id);
    if (!pending) {
      await interaction.reply({
        content: '❌ The configuration session has expired. Run `/configure` again.',
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const { geminiKey, runwayKey, geminiModel, runwayModel } = pending;
    pendingKeys.delete(interaction.user.id);

    try {
      await validateKeys(geminiKey, runwayKey);
      await saveKeys(interaction.client, interaction.user.id, geminiKey, runwayKey, geminiModel, runwayModel);

      const embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ Configuration Successful')
        .addFields(
          { name: 'Gemini Model', value: geminiModel, inline: true },
          { name: 'Runway Model', value: runwayModel, inline: true },
        )
        .setDescription('Your API keys have been encrypted and stored in a private DM.\nUse `/ads` to start creating video ads.')
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply({
        content: `❌ **Validation failed:** ${err.message}\n\nPlease double-check your API keys and run \`/configure\` again.`,
      });
    }

    return true;
  }

  return false;
}

// ─── Modal Submit Handler ──────────────────────────────────────────────────────

/**
 * Handle modal submission — store keys temporarily, show model selectors.
 */
export async function handleModalSubmit(interaction) {
  if (interaction.customId !== MODAL_CONFIG) return false;

  const geminiKey = interaction.fields.getTextInputValue(INPUT_GEMINI_KEY).trim();
  const runwayKey = interaction.fields.getTextInputValue(INPUT_RUNWAY_KEY).trim();

  // Pre-populate with defaults so user can save without changing anything
  pendingKeys.set(interaction.user.id, {
    geminiKey,
    runwayKey,
    geminiModel: GEMINI_MODELS.find((m) => m.default)?.value ?? GEMINI_MODELS[0].value,
    runwayModel: RUNWAY_MODELS.find((m) => m.default)?.value ?? RUNWAY_MODELS[0].value,
  });

  // Auto-clear after 5 minutes to avoid memory leaks
  setTimeout(() => pendingKeys.delete(interaction.user.id), 5 * 60 * 1000);

  const geminiSelectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(SELECT_GEMINI_MODEL)
      .setPlaceholder('Choose the Gemini model...')
      .addOptions(GEMINI_MODELS),
  );

  const runwaySelectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(SELECT_RUNWAY_MODEL)
      .setPlaceholder('Choose the Runway model...')
      .addOptions(RUNWAY_MODELS),
  );

  const saveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_SAVE_CONFIG)
      .setLabel('💾 Save Configuration')
      .setStyle(ButtonStyle.Success),
  );

  await interaction.reply({
    content: '**Select the model you want to use:**\nDefaults are pre-selected. Change if needed, then click **Save Configuration**.',
    components: [geminiSelectRow, runwaySelectRow, saveRow],
    ephemeral: true,
  });

  return true;
}

// ─── Select Menu Handler ───────────────────────────────────────────────────────

/**
 * Handle model selection dropdowns.
 * Waits until both models are selected, then validates and saves.
 */
export async function handleSelectMenu(interaction) {
  const { customId, user } = interaction;
  if (customId !== SELECT_GEMINI_MODEL && customId !== SELECT_RUNWAY_MODEL) return false;

  const pending = pendingKeys.get(user.id);
  if (!pending) {
    await interaction.reply({
      content: '❌ The configuration session has expired. Run `/configure` again.',
      ephemeral: true,
    });
    return true;
  }

  // Update the selected model and acknowledge without changing the message
  if (customId === SELECT_GEMINI_MODEL) {
    pending.geminiModel = interaction.values[0];
  } else {
    pending.runwayModel = interaction.values[0];
  }

  await interaction.deferUpdate();
  return true;
}
