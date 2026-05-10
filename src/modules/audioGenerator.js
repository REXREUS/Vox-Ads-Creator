/**
 * Audio Generator module.
 *
 * Generates background music and per-scene narration for video ads using Runway Audio API:
 * - Background music: eleven_text_to_sound_v2 (sound effect model)
 * - Scene narration: eleven_multilingual_v2 (TTS model)
 *
 * Requirements: 11.3
 */

import RunwayML from '@runwayml/sdk';
import { createWriteStream } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const TEMP_BASE = process.env.TEMP_DIR || '/tmp/vox_jobs';

// Valid TTS voice presets from Runway eleven_multilingual_v2
const VALID_VOICES = new Set([
  'Maya', 'Arjun', 'Serene', 'Bernard', 'Billy', 'Mark', 'Clint', 'Mabel',
  'Chad', 'Leslie', 'Eleanor', 'Elias', 'Elliot', 'Grungle', 'Brodie', 'Sandra',
  'Kirk', 'Kylie', 'Lara', 'Lisa', 'Malachi', 'Marlene', 'Martin', 'Miriam',
  'Monster', 'Paula', 'Pip', 'Rusty', 'Ragnar', 'Xylar', 'Maggie', 'Jack',
  'Katie', 'Noah', 'James', 'Rina', 'Ella', 'Mariah', 'Frank', 'Claudia',
  'Niki', 'Vincent', 'Kendrick', 'Myrna', 'Tom', 'Wanda', 'Benjamin', 'Kiana', 'Rachel',
]);
const DEFAULT_VOICE = 'Eleanor'; // Neutral, professional female voice

/**
 * Normalize voice name — case-insensitive match against valid presets.
 * Falls back to DEFAULT_VOICE if not found.
 */
function normalizeVoice(voice) {
  if (!voice) return DEFAULT_VOICE;
  // Case-insensitive lookup
  const match = [...VALID_VOICES].find(v => v.toLowerCase() === voice.toLowerCase());
  return match ?? DEFAULT_VOICE;
}

/**
 * Generate background music from an audio mood description and download it.
 *
 * @param {string} audioMood - Text description of the desired audio mood
 *   (e.g. "Upbeat Thai pop, comedic stings, 128 BPM")
 * @param {string} runwayKey - User's Runway API key (BYOK)
 * @param {string} jobId     - Discord Thread ID used as unique job identifier
 * @returns {Promise<string>} Local path to the downloaded audio file
 */
export async function generateBackgroundMusic(audioMood, runwayKey, jobId) {
  const client = new RunwayML({ apiKey: runwayKey });

  console.log(`[AudioGenerator] Generating background music for job ${jobId}: "${audioMood}"`);

  const task = await client.soundEffect.create({
    model: 'eleven_text_to_sound_v2',
    promptText: audioMood,
  }).waitForTaskOutput();

  if (!task.output || task.output.length === 0) {
    throw new Error('Runway Audio API returned no output');
  }

  const audioUrl = task.output[0];
  const jobDir = path.join(TEMP_BASE, jobId);

  await fs.mkdir(jobDir, { recursive: true });

  const audioPath = path.join(jobDir, 'bg_music.mp3');
  await downloadAudio(audioUrl, audioPath);

  console.log(`[AudioGenerator] Background music saved to: ${audioPath}`);
  return audioPath;
}

/**
 * Trim narration text to fit within a scene's duration at natural speaking pace.
 * ~2.5 words/second, with 0.5s breathing room.
 *
 * @param {string} text         - Original narration text
 * @param {number} durationSecs - Scene duration in seconds
 * @returns {string} Trimmed text safe to speak within the duration
 */
function trimNarrationToFit(text, durationSecs) {
  const maxWords = Math.floor((durationSecs - 0.5) * 2.5);
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();

  const trimmed = words.slice(0, maxWords).join(' ');
  // End on a clean sentence boundary if possible
  const lastPunct = Math.max(trimmed.lastIndexOf('.'), trimmed.lastIndexOf('!'), trimmed.lastIndexOf('?'));
  if (lastPunct > trimmed.length * 0.6) {
    return trimmed.slice(0, lastPunct + 1);
  }
  return trimmed + '.';
}

/**
 * Generate TTS narration for a single scene using eleven_multilingual_v2.
 *
 * @param {string} narrationText - The voiceover text for this scene
 * @param {string} voice         - Voice preset: any valid Runway presetId (e.g. 'Eleanor', 'Vincent', 'Serene')
 * @param {string} runwayKey     - User's Runway API key (BYOK)
 * @param {string} jobId         - Discord Thread ID used as unique job identifier
 * @param {number} sceneId       - Scene number (1-indexed), used for filename
 * @param {number} [sceneDuration] - Scene duration in seconds (used to trim text to fit)
 * @returns {Promise<string>} Local path to the downloaded narration audio file
 */
export async function generateSceneNarration(narrationText, voice, runwayKey, jobId, sceneId, sceneDuration = 5) {
  const client = new RunwayML({ apiKey: runwayKey });

  // Sanitize voice — fall back to default if invalid
  const safeVoice = normalizeVoice(voice);

  // Guard: trim text to fit within scene duration
  const safeText = trimNarrationToFit(narrationText, sceneDuration);
  if (safeText !== narrationText.trim()) {
    console.warn(`[AudioGenerator] Scene ${sceneId} narration trimmed to fit ${sceneDuration}s: "${safeText}"`);
  }

  console.log(`[AudioGenerator] Generating narration scene ${sceneId} (voice: ${safeVoice}, ${sceneDuration}s): "${safeText}"`);

  const task = await client.textToSpeech.create({
    model: 'eleven_multilingual_v2',
    promptText: safeText,
    voice: { type: 'runway-preset', presetId: safeVoice },
  }).waitForTaskOutput();

  if (!task.output || task.output.length === 0) {
    throw new Error(`Runway TTS returned no output for scene ${sceneId}`);
  }

  const audioUrl = task.output[0];
  const jobDir = path.join(TEMP_BASE, jobId);

  await fs.mkdir(jobDir, { recursive: true });

  const audioPath = path.join(jobDir, `narration_${sceneId}.mp3`);
  await downloadAudio(audioUrl, audioPath);

  console.log(`[AudioGenerator] Narration scene ${sceneId} saved to: ${audioPath}`);
  return audioPath;
}

/**
 * Generate TTS narrations for all scenes in parallel.
 * Returns an ordered array of local audio paths (null for scenes with no narration text).
 *
 * @param {object[]} scenes      - Storyline scenes array
 * @param {string}   voice       - Voice preset from storyline.narration_voice
 * @param {string}   runwayKey
 * @param {string}   jobId
 * @returns {Promise<(string|null)[]>} Ordered array matching scenes index
 */
export async function generateAllNarrations(scenes, voice, runwayKey, jobId) {
  const results = await Promise.all(
    scenes.map(async (scene) => {
      const text = scene.narration_text?.trim();
      if (!text) return null;

      try {
        return await generateSceneNarration(text, voice, runwayKey, jobId, scene.scene_id, scene.duration ?? 5);
      } catch (err) {
        console.warn(`[AudioGenerator] Narration scene ${scene.scene_id} failed (non-fatal): ${err.message}`);
        return null;
      }
    })
  );

  return results;
}

/**
 * Download an audio file from a signed URL to a local path.
 *
 * @param {string} signedUrl  - Runway signed URL for the generated audio
 * @param {string} outputPath - Local destination path
 * @returns {Promise<void>}
 */
async function downloadAudio(signedUrl, outputPath) {
  const response = await fetch(signedUrl);

  if (!response.ok) {
    throw new Error(`Failed to download audio: HTTP ${response.status} from ${signedUrl}`);
  }

  const writeStream = createWriteStream(outputPath);
  await pipeline(Readable.fromWeb(response.body), writeStream);
}
