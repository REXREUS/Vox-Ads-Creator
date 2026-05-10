/**
 * Queue Manager module.
 *
 * Uses Discord threads as the job queue mechanism in guilds — fully stateless,
 * no server-side storage. Each video processing job gets its own thread
 * in the channel where /ads was invoked.
 *
 * In DM context (no guild), a lightweight "DM job context" is used instead:
 * progress messages are sent directly to the DM channel, and there is no
 * thread to archive.
 *
 * Thread lifecycle (guild):
 *   1. createJobThread()  — creates thread, posts initial JOB_STATE message
 *   2. updateProgress()   — posts status updates as the job progresses
 *   3. Thread is archived after job completes or fails
 *
 * DM lifecycle:
 *   1. createDMJobContext() — returns a pseudo-thread object backed by DM channel
 *   2. updateProgress()    — posts messages to DM channel
 *   3. closeDMJobContext()  — posts final message (no archive needed)
 *
 * Requirements: 8.1, 8.3, 8.4, 8.5, 18.5
 */

import { EmbedBuilder } from 'discord.js';

const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS ?? '3', 10);

// ─── UI Helpers ───────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  initializing: { emoji: '⏳', label: 'Initializing',   color: 0x5865f2 },
  uploading:    { emoji: '📤', label: 'Uploading',       color: 0x5865f2 },
  processing:   { emoji: '🎬', label: 'Processing',      color: 0xfaa61a },
  stitching:    { emoji: '🎞️', label: 'Stitching',       color: 0xfaa61a },
  delivering:   { emoji: '📦', label: 'Delivering',      color: 0x57f287 },
  completed:    { emoji: '✅', label: 'Completed',        color: 0x57f287 },
  failed:       { emoji: '❌', label: 'Failed',           color: 0xed4245 },
  cancelled:    { emoji: '🛑', label: 'Cancelled',        color: 0x99aab5 },
  paused_credit:{ emoji: '⏸️', label: 'Paused (Credits)', color: 0xfaa61a },
};

/**
 * Build a Discord embed representing the current job state.
 * The raw JSON is embedded in a hidden field so getJobState() can parse it back.
 *
 * @param {object} state
 * @returns {import('discord.js').EmbedBuilder}
 */
function buildJobStateEmbed(state) {
  const cfg = STATUS_CONFIG[state.status] ?? STATUS_CONFIG.initializing;

  const completed = Array.isArray(state.scenes_completed) ? state.scenes_completed : [];
  const pending   = Array.isArray(state.scenes_pending)   ? state.scenes_pending   : [];
  const failed    = Array.isArray(state.scenes_failed)    ? state.scenes_failed    : [];
  const total     = state.scenes_total ?? (completed.length + pending.length + failed.length);

  // Scene progress bar — e.g. ████░░░░ 2/6
  const filled = total > 0 ? Math.round((completed.length / total) * 8) : 0;
  const bar = '█'.repeat(filled) + '░'.repeat(8 - filled);

  const embed = new EmbedBuilder()
    .setColor(cfg.color)
    .setTitle(`${cfg.emoji} VOX-Ads Job — ${cfg.label}`)
    .addFields(
      { name: 'Status',    value: `${cfg.emoji} ${cfg.label}`,                                    inline: true },
      { name: 'Style',     value: state.style ?? 'auto',                                          inline: true },
      { name: 'Progress',  value: `${bar}  ${completed.length}/${total}`,                         inline: false },
    );

  if (failed.length > 0) {
    embed.addFields({ name: '⚠️ Failed Scenes', value: failed.join(', '), inline: true });
  }

  if (state.updated_at) {
    embed.setFooter({ text: `Last updated` }).setTimestamp(new Date(state.updated_at));
  } else {
    embed.setFooter({ text: `Started` }).setTimestamp(new Date(state.created_at));
  }

  // Store the minimal state needed for recovery in a hidden embed field.
  // We only keep the fields getJobState() and getActiveJobs() actually need.
  const persistState = {
    vox_type: state.vox_type,
    version: state.version,
    user_id: state.user_id,
    created_at: state.created_at,
    updated_at: state.updated_at,
    status: state.status,
    style: state.style,
    scenes_total: state.scenes_total,
    scenes_completed: state.scenes_completed,
    scenes_pending: state.scenes_pending,
    scenes_failed: state.scenes_failed,
  };
  // Discord embed field values are capped at 1024 chars.
  // If the JSON is too long, trim the pending array (least critical for recovery).
  let persistJson = JSON.stringify(persistState);
  if (persistJson.length > 990) {
    const trimmed = { ...persistState, scenes_pending: [], scenes_pending_trimmed: true };
    persistJson = JSON.stringify(trimmed);
  }
  embed.addFields({ name: '\u200b', value: `\`\`\`json\n${persistJson}\n\`\`\`` });

  return embed;
}

/**
 * Create a Discord thread for a new job and post the initial JOB_STATE message.
 *
 * The first message in the thread is the canonical job state record — it can
 * be updated via editJobState() to reflect progress without flooding the thread.
 *
 * @param {import('discord.js').TextChannel} channel - Channel where /ads was run
 * @param {string} userId - Discord user ID who initiated the job
 * @param {object} initialState - Initial job state fields to persist
 * @returns {Promise<{thread: import('discord.js').ThreadChannel, stateMessageId: string}>}
 */
export async function createJobThread(channel, userId, initialState = {}) {
  const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
  const threadName = `🎬 VOX Job — <@${userId}> — ${timestamp}`.slice(0, 100);

  const thread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: 1440, // 24 hours
    reason: `VOX-Ads job for user ${userId}`,
  });

  const jobState = {
    vox_type: 'JOB_STATE',
    version: 1,
    user_id: userId,
    created_at: new Date().toISOString(),
    scenes_completed: [],
    scenes_pending: [],
    scenes_failed: [],
    status: 'initializing',
    ...initialState,
  };

  const embed = buildJobStateEmbed(jobState);
  const stateMessage = await thread.send({ embeds: [embed] });

  return { thread, stateMessageId: stateMessage.id };
}

/**
 * Post a progress update message to the job thread.
 * Truncates to Discord's 2000-char limit if needed.
 *
 * @param {import('discord.js').ThreadChannel} thread
 * @param {string} message - Human-readable status message
 * @returns {Promise<import('discord.js').Message>}
 */
export async function updateProgress(thread, message) {
  const safe = message.length > 2000 ? message.slice(0, 1997) + '...' : message;
  return thread.send(safe);
}

/**
 * Edit the pinned JOB_STATE message in the thread to reflect updated state.
 * Renders a visual embed and stores the raw state JSON in a hidden embed field
 * so getJobState() can recover it later.
 *
 * @param {import('discord.js').ThreadChannel} thread
 * @param {string} stateMessageId - ID of the first (state) message in the thread
 * @param {object} updatedState - Partial state fields to merge into existing state
 * @returns {Promise<import('discord.js').Message>}
 */
export async function editJobState(thread, stateMessageId, updatedState) {
  const stateMessage = await thread.messages.fetch(stateMessageId);
  let existing = {};

  // Recover existing state from the hidden JSON field in the embed
  try {
    const hiddenField = stateMessage.embeds?.[0]?.fields?.find((f) => f.name === '\u200b');
    if (hiddenField) {
      const jsonMatch = hiddenField.value.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) existing = JSON.parse(jsonMatch[1]);
    }
  } catch {
    // Fall back to empty state
  }

  const merged = {
    ...existing,
    ...updatedState,
    updated_at: new Date().toISOString(),
  };

  const embed = buildJobStateEmbed(merged);
  return stateMessage.edit({ embeds: [embed] });
}

/**
 * Read the current JOB_STATE from the thread's first message.
 * Recovers the state from the hidden JSON field in the embed.
 *
 * @param {import('discord.js').ThreadChannel} thread
 * @param {string} stateMessageId
 * @returns {Promise<object|null>}
 */
export async function getJobState(thread, stateMessageId) {
  try {
    const stateMessage = await thread.messages.fetch(stateMessageId);
    const hiddenField = stateMessage.embeds?.[0]?.fields?.find((f) => f.name === '\u200b');
    if (hiddenField) {
      const jsonMatch = hiddenField.value.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) return JSON.parse(jsonMatch[1]);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Count active (non-archived) VOX job threads across the guild.
 * A thread is counted as an active job if its oldest fetchable message
 * contains a JOB_STATE vox_type tag.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<number>}
 */
export async function getActiveJobs(guild) {
  const { threads } = await guild.channels.fetchActiveThreads();
  let count = 0;

  for (const thread of threads.values()) {
    try {
      // Fetch the earliest messages to find the JOB_STATE anchor
      const messages = await thread.messages.fetch({ limit: 5, after: '0' });
      for (const msg of messages.values()) {
        if (!msg.author.bot) continue;
        // Check embed hidden field (new format)
        const hiddenField = msg.embeds?.[0]?.fields?.find((f) => f.name === '\u200b');
        if (hiddenField) {
          try {
            const jsonMatch = hiddenField.value.match(/```json\n([\s\S]*?)\n```/);
            if (jsonMatch) {
              const data = JSON.parse(jsonMatch[1]);
              if (data.vox_type === 'JOB_STATE') { count++; break; }
            }
          } catch { /* skip */ }
        }
        // Fallback: legacy raw JSON content
        try {
          const data = JSON.parse(msg.content);
          if (data.vox_type === 'JOB_STATE') { count++; break; }
        } catch { /* skip */ }
      }
    } catch {
      // Thread may be inaccessible — skip
    }
  }

  return count;
}

/**
 * Check whether the guild has reached its maximum concurrent job capacity.
 * Returns false (not at capacity) if guild is null (e.g. DM context).
 *
 * @param {import('discord.js').Guild|null} guild
 * @returns {Promise<boolean>}
 */
export async function isAtCapacity(guild) {
  if (!guild) return false;
  const active = await getActiveJobs(guild);
  return active >= MAX_CONCURRENT_JOBS;
}

/**
 * Archive (close) a job thread after the job completes or fails.
 * Posts a final status message before archiving.
 *
 * @param {import('discord.js').ThreadChannel} thread
 * @param {string} finalMessage - Summary message to post before archiving
 * @returns {Promise<void>}
 */
export async function closeJobThread(thread, finalMessage) {
  if (finalMessage) {
    await thread.send(finalMessage);
  }
  await thread.setArchived(true);
}

// ─── DM Job Context ───────────────────────────────────────────────────────────

/**
 * Create a lightweight job context for DM usage (no guild, no threads).
 * Returns an object with the same interface as a thread so the pipeline
 * can call updateProgress / editJobState / closeJobThread without branching.
 *
 * The "stateMessage" is a pinned JSON message in the DM channel.
 *
 * @param {import('discord.js').DMChannel} dmChannel
 * @param {string} userId
 * @param {object} initialState
 * @returns {Promise<{thread: object, stateMessageId: string}>}
 */
export async function createDMJobContext(dmChannel, userId, initialState = {}) {
  const jobState = {
    vox_type: 'JOB_STATE',
    version: 1,
    user_id: userId,
    created_at: new Date().toISOString(),
    scenes_completed: [],
    scenes_pending: [],
    scenes_failed: [],
    status: 'initializing',
    ...initialState,
  };

  const embed = buildJobStateEmbed(jobState);
  const stateMessage = await dmChannel.send({ embeds: [embed] });

  // Return a pseudo-thread object that wraps the DM channel
  // so updateProgress / editJobState / closeJobThread work unchanged
  const pseudoThread = {
    id: `dm_${userId}_${Date.now()}`,
    isDM: true,
    send: (content) => dmChannel.send(content),
    messages: {
      fetch: (opts) => dmChannel.messages.fetch(opts),
    },
    setArchived: async () => {}, // no-op in DM
  };

  return { thread: pseudoThread, stateMessageId: stateMessage.id };
}
