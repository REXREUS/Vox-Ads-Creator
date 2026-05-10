/**
 * Admin configuration helpers.
 *
 * Reads ADMIN_CONFIG from the guild owner's DM to enforce:
 *   - Per-user rate limiting (max N videos per hour)
 *   - Whitelist (bypass rate limit)
 *   - Blacklist (block from /ads)
 *
 * Requirements: 14.1, 14.4, 14.5
 */

import { readFromDM, getCreditHistory } from './discordStorage.js';

const DEFAULT_RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_HOUR ?? '3', 10);

/**
 * Load ADMIN_CONFIG from the guild owner's DM.
 * Returns null if no config is stored.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<object|null>}
 */
async function getAdminConfig(client, guild) {
  if (!guild) return null;
  try {
    return await readFromDM(client, guild.ownerId, 'ADMIN_CONFIG');
  } catch {
    return null;
  }
}

/**
 * Check whether a user is blacklisted in this guild.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function isBlacklisted(client, guild, userId) {
  const config = await getAdminConfig(client, guild);
  if (!config?.blacklist) return false;
  return config.blacklist.includes(userId);
}

/**
 * Check whether a user is whitelisted (bypasses rate limit).
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function isWhitelisted(client, guild, userId) {
  const config = await getAdminConfig(client, guild);
  if (!config?.whitelist) return false;
  return config.whitelist.includes(userId);
}

/**
 * Check whether a user has exceeded the per-hour rate limit.
 * Whitelisted users always pass. Blacklisted users are handled separately.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @returns {Promise<{allowed: boolean, used: number, limit: number}>}
 */
export async function checkRateLimit(client, guild, userId) {
  // Whitelisted users bypass rate limit
  if (await isWhitelisted(client, guild, userId)) {
    return { allowed: true, used: 0, limit: Infinity };
  }

  const config = await getAdminConfig(client, guild);
  const limit = config?.rate_limit_per_hour ?? DEFAULT_RATE_LIMIT;

  // Count completed/partial jobs in the last hour from CREDIT_LOG
  const history = await getCreditHistory(client, userId).catch(() => []);
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const recentJobs = history.filter((entry) => {
    if (!entry.timestamp) return false;
    const ts = new Date(entry.timestamp).getTime();
    // Only count jobs that actually consumed credits (not failed before processing)
    return ts >= oneHourAgo && (entry.status === 'completed' || entry.status === 'partial');
  });

  const used = recentJobs.length;
  return { allowed: used < limit, used, limit };
}
