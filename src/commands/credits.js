/**
 * /credits command — display credit usage summary from DM history
 * and current Runway credit balance via API.
 *
 * Reads CREDIT_LOG messages from the user's DM, calculates total usage,
 * and displays a breakdown per job as an ephemeral embed.
 * Sends a warning if usage is high relative to a threshold.
 *
 * Requirements: 6.1, 6.2, 6.4
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getCreditHistory } from '../modules/discordStorage.js';
import { getKeys } from '../modules/byok.js';

// Warning threshold: warn user when total Runway credits exceed this value
const RUNWAY_CREDIT_WARNING_THRESHOLD = 1000;

// Max number of recent jobs to show in the breakdown
const MAX_HISTORY_DISPLAY = 10;

const RUNWAY_API_BASE = 'https://api.dev.runwayml.com';
const RUNWAY_VERSION = '2024-11-06';

/**
 * Fetch current Runway credit balance via REST API.
 * Returns null if the call fails (non-fatal).
 *
 * @param {string} runwayKey
 * @returns {Promise<{balance: number, tier: string|null, models: object|null, usage: object|null}|null>}
 */
async function fetchRunwayBalance(runwayKey) {
  try {
    const res = await fetch(`${RUNWAY_API_BASE}/v1/organization`, {
      headers: {
        Authorization: `Bearer ${runwayKey}`,
        'X-Runway-Version': RUNWAY_VERSION,
      },
    });
    if (!res.ok) {
      console.error(`[credits] fetchRunwayBalance HTTP ${res.status}: ${await res.text()}`);
      return null;
    }
    const data = await res.json();

    const tierObj = data.tier ?? null;
    const tierLabel = tierObj?.maxMonthlyCreditSpend
      ? `${(tierObj.maxMonthlyCreditSpend / 1000).toFixed(0)}k/mo limit`
      : null;

    return {
      balance: data.creditBalance ?? null,
      tier: tierLabel,
      models: tierObj?.models ?? null,
      usage: data.usage?.models ?? null,
    };
  } catch (err) {
    console.error('[credits] fetchRunwayBalance error:', err.message);
    return null;
  }
}

// Models relevant to VOX-Ads — shown first, others collapsed into "others"
const VOX_MODELS = ['gen4.5', 'gen4_turbo', 'seedance2', 'gen4_aleph', 'eleven_multilingual_v2', 'eleven_text_to_sound_v2'];

/**
 * Build a compact model usage string from tier limits and daily usage.
 * Format per model: `modelName: used/max`
 * VOX-relevant models are shown first, then remaining models grouped.
 *
 * @param {object} tierModels  - tier.models from API
 * @param {object} usageModels - usage.models from API
 * @returns {string}
 */
function buildModelUsageText(tierModels, usageModels) {
  if (!tierModels) return '_No model data available._';

  const lines = [];

  // VOX-relevant models first
  for (const model of VOX_MODELS) {
    if (!tierModels[model]) continue;
    const used = usageModels?.[model]?.dailyGenerations ?? 0;
    const max = tierModels[model].maxDailyGenerations;
    const bar = used >= max ? '🔴' : used > 0 ? '🟡' : '🟢';
    lines.push(`${bar} \`${model}\` — **${used}/${max}**/day`);
  }

  // Remaining models (non-VOX) — show only those with usage > 0 or collapse
  const others = Object.entries(tierModels)
    .filter(([m]) => !VOX_MODELS.includes(m))
    .map(([model, limits]) => {
      const used = usageModels?.[model]?.dailyGenerations ?? 0;
      const max = limits.maxDailyGenerations;
      const bar = used >= max ? '🔴' : used > 0 ? '🟡' : '🟢';
      return { model, used, max, bar };
    });

  const activeOthers = others.filter((o) => o.used > 0);
  if (activeOthers.length > 0) {
    lines.push('');
    lines.push('**Other models (active today):**');
    for (const { model, used, max, bar } of activeOthers) {
      lines.push(`${bar} \`${model}\` — **${used}/${max}**/day`);
    }
  }

  const inactiveCount = others.length - activeOthers.length;
  if (inactiveCount > 0) {
    lines.push(`_+ ${inactiveCount} other model(s) with 0 usage today_`);
  }

  return lines.join('\n') || '_No model data._';
}

export const data = new SlashCommandBuilder()
  .setName('credits')
  .setDescription('View a summary of your API credit usage from DM history');

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;

  try {
    // Fetch credit history and live balance in parallel
    const keys = await getKeys(interaction.client, userId);
    console.log('[credits] keys found:', !!keys, keys ? `runwayKey length: ${keys.runwayKey?.length}` : 'no keys');
    const [history, liveBalance] = await Promise.all([
      getCreditHistory(interaction.client, userId),
      keys ? fetchRunwayBalance(keys.runwayKey) : Promise.resolve(null),
    ]);
    console.log('[credits] liveBalance:', liveBalance);

    if (history.length === 0 && !liveBalance) {
      await interaction.editReply({
        content:
          '📊 **No credit usage history yet.**\n' +
          'Use `/ads` to create your first video ad.',
      });
      return;
    }

    // ── Aggregate totals ──────────────────────────────────────────────────────
    let totalRunwayCredits = 0;
    let totalGeminiTokens = 0;
    let totalScenesProcessed = 0;
    let completedJobs = 0;
    let failedJobs = 0;

    for (const entry of history) {
      totalRunwayCredits += entry.runway_credits_used ?? 0;
      totalGeminiTokens += entry.gemini_tokens_used ?? 0;
      totalScenesProcessed += entry.scenes_processed ?? 0;
      if (entry.status === 'completed') completedJobs++;
      else if (entry.status === 'failed') failedJobs++;
    }

    // ── Build per-job breakdown (most recent first) ───────────────────────────
    const recentJobs = [...history].reverse().slice(0, MAX_HISTORY_DISPLAY);

    const jobLines = recentJobs.map((entry) => {
      const date = entry.timestamp
        ? new Date(entry.timestamp).toLocaleDateString('id-ID', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
        : 'Unknown';

      const statusIcon = entry.status === 'completed' ? '✅' : entry.status === 'failed' ? '❌' : '⏳';
      const credits = entry.runway_credits_used ?? 0;
      const model = entry.runway_model ?? 'unknown';
      const scenes = entry.scenes_processed ?? 0;

      return `${statusIcon} \`${date}\` — **${credits} cr** · ${scenes} scenes · ${model}`;
    });

    // ── Determine warning state ───────────────────────────────────────────────
    const isHighUsage = totalRunwayCredits >= RUNWAY_CREDIT_WARNING_THRESHOLD;

    // ── Build embed ───────────────────────────────────────────────────────────
    const embed = new EmbedBuilder()
      .setTitle('📊 Summary of Credit Use')
      .setColor(isHighUsage ? 0xfee75c : 0x5865f2)
      .addFields(
        {
          name: '🎬 Total Runway Credits',
          value: `**${totalRunwayCredits.toLocaleString()}** credits`,
          inline: true,
        },
        {
          name: '🤖 Total Gemini Tokens',
          value: `**${totalGeminiTokens.toLocaleString()}** tokens`,
          inline: true,
        },
        {
          name: '🎞️ Total Scenes',
          value: `**${totalScenesProcessed}** scenes`,
          inline: true,
        },
        {
          name: '📁 Total Jobs',
          value: `**${history.length}** total · ✅ ${completedJobs} completed · ❌ ${failedJobs} failed`,
          inline: false,
        },
      )
      .setTimestamp();

    if (jobLines.length > 0) {
      embed.addFields({
        name: `🕐 Recent History (${recentJobs.length} from ${history.length})`,
        value: jobLines.join('\n'),
        inline: false,
      });
    }

    // ── Live Runway balance (top of embed, added after history fields) ────────
    if (liveBalance?.balance !== null && liveBalance?.balance !== undefined) {
      const balanceWarning = liveBalance.balance < 100 ? ' ⚠️ Low!' : '';
      embed.spliceFields(0, 0, {
        name: '💳 Runway Balance (Live)',
        value: `**${liveBalance.balance.toLocaleString()} credits**${balanceWarning}${liveBalance.tier ? ` · Tier ${liveBalance.tier}` : ''}`,
        inline: false,
      });

      // Model usage breakdown
      if (liveBalance.models) {
        const modelText = buildModelUsageText(liveBalance.models, liveBalance.usage);
        embed.spliceFields(1, 0, {
          name: '🎛️ Daily Model Usage',
          value: modelText.slice(0, 1024),
          inline: false,
        });
      }
    } else if (!keys) {
      embed.spliceFields(0, 0, {
        name: '💳 Runway Balance',
        value: '_Run `/configure` to see your live balance._',
        inline: false,
      });
    }

    if (isHighUsage) {
      embed.setFooter({
        text: `⚠️ Your credit usage has exceeded ${RUNWAY_CREDIT_WARNING_THRESHOLD.toLocaleString()} credits. Monitor your Runway balance.`,
      });
    }

    await interaction.editReply({ embeds: [embed] });

    // ── Send DM warning if high usage ─────────────────────────────────────────
    if (isHighUsage) {
      try {
        const user = await interaction.client.users.fetch(userId);
        const dm = await user.createDM();
        await dm.send(
        `⚠️ **Credit Usage Warning**\n` +
        `Your total Runway credit usage has reached **${totalRunwayCredits.toLocaleString()} credits**.\n` +
        `Please ensure your Runway balance is sufficient before creating a new ad.`,
        );
      } catch {
        // DM might be closed — warning already shown in ephemeral embed
      }
    }
  } catch (err) {
    console.error('[credits] Error reading credit history:', err);
    await interaction.editReply({
      content: `❌ Failed to read credit history: ${err.message}`,
    });
  }
}
