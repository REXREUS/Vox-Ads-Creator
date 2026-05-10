/**
 * Discord DM / Thread storage abstraction.
 *
 * All persistent state is stored as JSON messages in the bot↔user DM channel.
 * Each message carries a `vox_type` field used as a tag for filtering.
 *
 * Supported vox_type values:
 *   BYOK_KEYS    – encrypted API keys + model preferences
 *   CREDIT_LOG   – per-job credit usage entry
 *   VIDEO_HISTORY – completed video metadata
 *   ADMIN_CONFIG  – admin-level configuration (showcase channel, rate limits)
 *   JOB_STATE     – in-progress job state (stored in thread, not DM)
 */

// Maximum messages to fetch per Discord API call (Discord cap: 100)
const FETCH_LIMIT = 100;

/**
 * Open (or reuse) the DM channel between the bot and a user.
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @returns {Promise<import('discord.js').DMChannel>}
 */
async function getDMChannel(client, userId) {
  const user = await client.users.fetch(userId);
  return user.createDM();
}

/**
 * Fetch all messages from a DM channel that match a given vox_type.
 * Handles both inline JSON messages and file-attachment fallback messages
 * (used when the payload exceeds Discord's 2000-char limit).
 *
 * @param {import('discord.js').DMChannel} channel
 * @param {string} voxType
 * @returns {Promise<Array<{message: import('discord.js').Message, data: object}>>}
 */
async function fetchByType(channel, voxType) {
  const results = [];
  let lastId = null;

  while (true) {
    const options = { limit: FETCH_LIMIT };
    if (lastId) options.before = lastId;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      // Only process messages sent by the bot itself
      if (!msg.author.bot) continue;

      // ── Inline JSON (normal path) ──────────────────────────────────────────
      try {
        // Strip markdown code fences if present (```json\n...\n```)
        const raw = msg.content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
        const data = JSON.parse(raw);
        if (data.vox_type === voxType) {
          results.push({ message: msg, data });
          continue;
        }
      } catch {
        // Not inline JSON — check attachment fallback below
      }

      // ── Attachment fallback (oversized payload) ────────────────────────────
      if (msg.content === `vox_storage:${voxType}` && msg.attachments.size > 0) {
        const attachment = msg.attachments.first();
        try {
          const res = await fetch(attachment.url);
          if (res.ok) {
            const data = await res.json();
            if (data.vox_type === voxType) {
              results.push({ message: msg, data });
            }
          }
        } catch {
          // Attachment unreadable — skip
        }
      }
    }

    lastId = batch.last()?.id;
    // If we got fewer than the limit, we've reached the beginning
    if (batch.size < FETCH_LIMIT) break;
  }

  return results;
}

// Discord message content limit
const DISCORD_MAX_LENGTH = 2000;

/**
 * Save a data object to the user's DM as a tagged JSON message.
 * If the serialised payload exceeds Discord's 2000-char limit, it is sent
 * as a file attachment so the message always succeeds.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @param {string} voxType  - Tag identifying the message type
 * @param {object} data     - Payload to store (will be JSON-serialised)
 * @param {import('discord.js').EmbedBuilder} [displayEmbed] - Optional pretty embed sent after the storage message
 * @returns {Promise<import('discord.js').Message>} The sent storage message
 */
export async function saveToDM(client, userId, voxType, data, displayEmbed = null) {
  const channel = await getDMChannel(client, userId);
  const payload = {
    vox_type: voxType,
    version: 1,
    timestamp: new Date().toISOString(),
    ...data,
  };
  const json = JSON.stringify(payload);

  let storageMsg;
  if (json.length <= DISCORD_MAX_LENGTH - 10) {
    // Send as hidden code block — parseable by fetchByType, readable by humans
    storageMsg = await channel.send(`\`\`\`json\n${json}\n\`\`\``);
  } else {
    // Payload too large — send as file attachment with a short header message
    // so fetchByType can still find it by parsing the attachment content
    const { AttachmentBuilder } = await import('discord.js');
    const attachment = new AttachmentBuilder(Buffer.from(json, 'utf8'), {
      name: `vox_${voxType.toLowerCase()}.json`,
    });
    storageMsg = await channel.send({
      content: `vox_storage:${voxType}`,
      files: [attachment],
    });
  }

  // Send optional display embed after the storage message
  if (displayEmbed) {
    await channel.send({ embeds: [displayEmbed] });
  }

  return storageMsg;
}

/**
 * Read the most recent message of a given vox_type from the user's DM.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @param {string} voxType
 * @returns {Promise<object|null>} Parsed data object, or null if not found
 */
export async function readFromDM(client, userId, voxType) {
  const channel = await getDMChannel(client, userId);
  const matches = await fetchByType(channel, voxType);
  if (matches.length === 0) return null;

  // Return the most recent match (fetchByType returns newest-first due to Discord ordering)
  return matches[0].data;
}

/**
 * Delete all DM messages of a given vox_type for a user.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @param {string} voxType
 * @returns {Promise<number>} Number of messages deleted
 */
export async function deleteFromDM(client, userId, voxType) {
  const channel = await getDMChannel(client, userId);
  const matches = await fetchByType(channel, voxType);

  let deleted = 0;
  for (const { message } of matches) {
    try {
      await message.delete();
      deleted++;
    } catch {
      // Message may already be gone — continue
    }
  }
  return deleted;
}

/**
 * Append a credit usage entry to the user's DM history.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @param {{job_id: string, runway_credits_used: number, gemini_tokens_used: number, scenes_processed: number, runway_model: string, status: string}} usage
 * @returns {Promise<import('discord.js').Message>}
 */
export async function appendCreditLog(client, userId, usage) {
  const { EmbedBuilder } = await import('discord.js');

  const statusEmoji = usage.status === 'completed' ? '✅' : usage.status === 'partial' ? '⚠️' : '❌';
  const statusLabel = usage.status === 'completed' ? 'Completed' : usage.status === 'partial' ? 'Partial' : 'Failed';
  const color = usage.status === 'completed' ? 0x57f287 : usage.status === 'partial' ? 0xfee75c : 0xed4245;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${statusEmoji} Job ${statusLabel}`)
    .addFields(
      { name: '🎬 Runway Credits', value: `**${usage.runway_credits_used}** cr`, inline: true },
      { name: '🤖 Gemini Tokens', value: `**${usage.gemini_tokens_used ?? 0}**`, inline: true },
      { name: '🎞️ Scenes', value: `**${usage.scenes_processed}**`, inline: true },
      { name: '🧠 Model', value: usage.runway_model ?? 'gen4.5', inline: true },
      { name: '🆔 Job ID', value: `\`${String(usage.job_id).slice(-12)}\``, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: 'VOX-Ads · Credit Log' });

  return saveToDM(client, userId, 'CREDIT_LOG', usage, embed);
}

/**
 * Retrieve all credit log entries for a user, sorted oldest-first.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @returns {Promise<object[]>} Array of credit log data objects
 */
export async function getCreditHistory(client, userId) {
  const channel = await getDMChannel(client, userId);
  const matches = await fetchByType(channel, 'CREDIT_LOG');
  // fetchByType returns newest-first; reverse for chronological order
  return matches.map(({ data }) => data).reverse();
}

/**
 * Retrieve all video history entries for a user, sorted newest-first.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @returns {Promise<object[]>} Array of video history data objects
 */
export async function getVideoHistory(client, userId) {
  const channel = await getDMChannel(client, userId);
  const matches = await fetchByType(channel, 'VIDEO_HISTORY');
  // fetchByType returns newest-first — keep that order for gallery display
  return matches.map(({ data }) => data);
}

/**
 * Delete ALL messages sent by the bot in the user's DM channel.
 * Used by /forget to fully clear the chat history.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @returns {Promise<number>} Number of messages deleted
 */
export async function clearDMHistory(client, userId) {
  const channel = await getDMChannel(client, userId);
  let deleted = 0;
  let lastId = null;

  while (true) {
    const options = { limit: FETCH_LIMIT };
    if (lastId) options.before = lastId;

    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      if (!msg.author.bot) continue;
      try {
        await msg.delete();
        deleted++;
      } catch {
        // Message may already be gone — continue
      }
    }

    lastId = batch.last()?.id;
    if (batch.size < FETCH_LIMIT) break;
  }

  return deleted;
}
