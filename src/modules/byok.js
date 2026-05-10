/**
 * BYOK (Bring Your Own Key) module.
 *
 * Stores encrypted API keys + model preferences in the user's Discord DM.
 * Keys are encrypted with AES-256-GCM (see src/utils/crypto.js) so only
 * the correct user + BOT_SECRET combination can decrypt them.
 *
 * DM message format (vox_type: "BYOK_KEYS"):
 * {
 *   vox_type: "BYOK_KEYS",
 *   version: 1,
 *   timestamp: "...",
 *   geminiModel: "gemini-2.5-flash",
 *   runwayModel: "gen4.5",
 *   payload: "<AES-256-GCM encrypted base64>"   ← contains geminiKey + runwayKey
 * }
 */

import { encrypt, decrypt } from '../utils/crypto.js';
import { saveToDM, readFromDM, deleteFromDM } from './discordStorage.js';
import { GoogleGenAI } from '@google/genai';
import RunwayML from '@runwayml/sdk';
import { EmbedBuilder } from 'discord.js';

const VOX_TYPE = 'BYOK_KEYS';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_RUNWAY_MODEL = 'gen4.5';

/**
 * Encrypt and save API keys + model preferences to the user's DM.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @param {string} geminiKey
 * @param {string} runwayKey
 * @param {string} [geminiModel]
 * @param {string} [runwayModel]
 * @returns {Promise<import('discord.js').Message>}
 */
export async function saveKeys(client, userId, geminiKey, runwayKey, geminiModel, runwayModel) {
  // Delete any existing key messages before saving new ones
  await deleteFromDM(client, userId, VOX_TYPE);

  const plaintext = JSON.stringify({ geminiKey, runwayKey });
  const payload = encrypt(plaintext, userId);

  const displayEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🔐 API Keys Saved')
    .setDescription('Your API keys have been encrypted and stored securely in this DM.')
    .addFields(
      { name: '🤖 Gemini Model', value: geminiModel ?? DEFAULT_GEMINI_MODEL, inline: true },
      { name: '🎬 Runway Model', value: runwayModel ?? DEFAULT_RUNWAY_MODEL, inline: true },
      { name: '🔒 Encryption', value: 'AES-256-GCM', inline: true },
    )
    .setTimestamp()
    .setFooter({ text: 'VOX-Ads · Keys are never stored in plaintext' });

  return saveToDM(client, userId, VOX_TYPE, {
    geminiModel: geminiModel ?? DEFAULT_GEMINI_MODEL,
    runwayModel: runwayModel ?? DEFAULT_RUNWAY_MODEL,
    payload,
  }, displayEmbed);
}

/**
 * Retrieve and decrypt API keys from the user's DM.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @returns {Promise<{geminiKey: string, runwayKey: string, geminiModel: string, runwayModel: string}|null>}
 */
export async function getKeys(client, userId) {
  const data = await readFromDM(client, userId, VOX_TYPE);
  if (!data) return null;

  const plaintext = decrypt(data.payload, userId);
  const { geminiKey, runwayKey } = JSON.parse(plaintext);

  return {
    geminiKey,
    runwayKey,
    geminiModel: data.geminiModel ?? DEFAULT_GEMINI_MODEL,
    runwayModel: data.runwayModel ?? DEFAULT_RUNWAY_MODEL,
  };
}

/**
 * Delete all BYOK key messages from the user's DM.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @returns {Promise<number>} Number of messages deleted
 */
export async function deleteKeys(client, userId) {
  return deleteFromDM(client, userId, VOX_TYPE);
}

/**
 * Validate API keys by making minimal test calls to each service.
 * Throws an error with a descriptive message if validation fails.
 *
 * @param {string} geminiKey
 * @param {string} runwayKey
 * @returns {Promise<void>}
 */
export async function validateKeys(geminiKey, runwayKey) {
  // Validate Gemini key — list models as a lightweight check
  try {
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    await ai.models.list();
  } catch (err) {
    throw new Error(`Gemini API key is invalid: ${err.message}`);
  }

  // Validate Runway key — list tasks (page size 1) as a lightweight auth check
  try {
    const runway = new RunwayML({ apiKey: runwayKey });
    await runway.tasks.list({ limit: 1 });
  } catch (err) {
    // A 401/403 means bad key; any other error (rate limit, network) is not a key problem
    const status = err?.status ?? err?.statusCode;
    if (status === 401 || status === 403) {
      throw new Error(`Runway API key is invalid: ${err.message}`);
    }
    // Non-auth errors — key format is accepted, treat as valid
  }
}
