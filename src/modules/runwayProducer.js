/**
 * Runway Producer module.
 *
 * Handles all Runway API interactions for video generation:
 * - Upload assets to Runway ephemeral storage
 * - Dispatch scene jobs SEQUENTIALLY with image chaining (Opsi A):
 *     Scene 1 uses the original asset; each subsequent scene uses the last
 *     frame of the previous clip as its promptImage, creating visual continuity.
 * - Video inputs (isVideo=true) skip chaining — seedance2/gen4_aleph use the
 *     original video as reference for all scenes.
 * - Download generated clips to /tmp/vox_jobs/{jobId}/
 * - Granular per-scene retry (max 3x) on TaskFailedError
 * - Disk space pre-flight check (reject if < 500MB free)
 * - Job directory cleanup in finally block
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 16.1
 */

import RunwayML from '@runwayml/sdk';
import { promises as fs } from 'fs';
import { createWriteStream } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const TEMP_BASE = process.env.TEMP_DIR || '/tmp/vox_jobs';
const MIN_DISK_MB = 500;
const MAX_SCENE_RETRIES = 3;

/**
 * Build a RunwayML client with the user's API key.
 * @param {string} runwayKey
 * @returns {RunwayML}
 */
function buildClient(runwayKey) {
  return new RunwayML({ apiKey: runwayKey });
}

/**
 * Upload an asset buffer to Runway ephemeral storage via REST API.
 * The SDK v1.x does not expose client.uploads — use the 3-step presigned URL flow.
 *
 * @param {Buffer} assetBuffer - Raw file buffer
 * @param {string} mimeType    - MIME type (e.g. 'image/jpeg', 'video/mp4')
 * @param {string} runwayKey   - User's Runway API key
 * @returns {Promise<string>} runway:// URI
 */
/**
 * Upload an asset buffer to Runway ephemeral storage via the SDK.
 *
 * @param {Buffer} assetBuffer - Raw file buffer
 * @param {string} mimeType    - MIME type (e.g. 'image/jpeg', 'video/mp4')
 * @param {string} runwayKey   - User's Runway API key
 * @returns {Promise<string>} runway:// URI
 */
export async function uploadAsset(assetBuffer, mimeType, runwayKey) {
  const client = buildClient(runwayKey);
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
  const filename = `asset.${ext}`;

  // SDK createEphemeral expects { file: File | Blob, fileMetadata? }
  // and returns { uri: 'runway://...' }
  const file = new File([assetBuffer], filename, { type: mimeType });

  let result;
  try {
    result = await client.uploads.createEphemeral({ file });
  } catch (err) {
    const msg = err.message ?? '';
    if (err.status === 403 || msg.includes('credit purchase is required')) {
      const e = new Error(
        'Your Runway account needs at least one credit purchase to use the API. ' +
        'Please top up your Runway credits at https://app.runwayml.com/settings/credits'
      );
      e.code = 'RUNWAY_NO_CREDITS';
      throw e;
    }
    throw err;
  }

  return result.uri;
}

/**
 * Check available disk space in /tmp.
 * Throws if less than MIN_DISK_MB (500MB) is available.
 *
 * Uses df command on Linux/Mac; falls back gracefully on Windows.
 *
 * @returns {Promise<void>}
 * @throws {Error} If disk space is insufficient
 */
export async function checkDiskSpace() {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // df -m /tmp returns available space in MB
    const { stdout } = await execFileAsync('df', ['-m', '/tmp']);
    const lines = stdout.trim().split('\n');
    // Second line has the data: Filesystem 1M-blocks Used Available Use% Mounted
    const parts = lines[1]?.split(/\s+/);
    const availableMB = parseInt(parts?.[3], 10);

    if (!isNaN(availableMB) && availableMB < MIN_DISK_MB) {
      throw new Error(
        `Insufficient disk space: ${availableMB}MB available, ${MIN_DISK_MB}MB required. Please try again later.`
      );
    }
  } catch (err) {
    // Re-throw disk space errors; ignore df command failures (e.g. Windows)
    if (err.message.startsWith('Insufficient disk space')) {
      throw err;
    }
    console.warn('[RunwayProducer] Could not check disk space:', err.message);
  }
}

/**
 * Dispatch scene jobs SEQUENTIALLY with image chaining.
 *
 * For image inputs:
 *   - Scene 1 uses the original asset (assetRunwayUri)
 *   - Scene N uses the last frame of scene N-1's clip as promptImage
 *   This creates visual continuity — each scene flows naturally from the previous.
 *
 * For video inputs (isVideo=true):
 *   - All scenes use the original video as reference (no chaining)
 *   - seedance2 and gen4_aleph are designed for video reference, not frame chaining
 *
 * Creates /tmp/vox_jobs/{jobId}/ directory for this job.
 *
 * @param {object} storyline       - Validated storyline JSON from Gemini Director
 * @param {string} runwayKey       - User's Runway API key
 * @param {string} assetRunwayUri  - runway:// URI from uploadAsset()
 * @param {string} jobId           - Discord Thread ID used as unique job identifier
 * @param {object} [options]
 * @param {boolean} [options.isVideo]       - True if input asset is a video
 * @param {Function} [options.onSceneDone]  - Callback(sceneId, totalScenes) for progress updates
 * @param {AbortSignal} [options.signal]    - AbortSignal to cancel the job mid-pipeline
 * @returns {Promise<string[]>} Ordered array of local clip file paths
 */
export async function dispatchSceneJobs(storyline, runwayKey, assetRunwayUri, jobId, options = {}) {
  const { isVideo = false, onSceneDone, signal } = options;
  const jobDir = path.join(TEMP_BASE, jobId);

  await fs.mkdir(jobDir, { recursive: true });

  const totalScenes = storyline.scenes.length;
  const runwayModel = storyline.runway_model || 'gen4.5';

  const clipPaths = [];
  const failed = [];

  // Current input URI — starts as original asset, updated to last frame after each scene
  let currentInputUri = assetRunwayUri;

  for (const scene of storyline.scenes) {
    // Check for cancellation before starting each scene
    if (signal?.aborted) {
      const cancelErr = new Error('Job cancelled by user.');
      cancelErr.code = 'JOB_CANCELLED';
      throw cancelErr;
    }

    try {
      const clipPath = await processSceneWithRetry(
        scene, runwayKey, currentInputUri, jobDir, runwayModel, isVideo, MAX_SCENE_RETRIES
      );

      clipPaths.push({ sceneId: scene.scene_id, clipPath, success: true });

      if (onSceneDone) onSceneDone(scene.scene_id, totalScenes);

      // Image chaining: extract last frame of this clip and upload for next scene
      // Skip chaining for video inputs — they always use the original video reference
      if (!isVideo && scene.scene_id < totalScenes) {
        try {
          const lastFrameUri = await extractAndUploadLastFrame(clipPath, runwayKey, jobDir, scene.scene_id);
          currentInputUri = lastFrameUri;
          console.log(`[RunwayProducer] Scene ${scene.scene_id} → chained to scene ${scene.scene_id + 1} via last frame`);
        } catch (chainErr) {
          // Chaining failed — fall back to original asset for next scene (non-fatal)
          console.warn(`[RunwayProducer] Frame extraction failed for scene ${scene.scene_id}, using original asset: ${chainErr.message}`);
          currentInputUri = assetRunwayUri;
        }
      }
    } catch (err) {
      console.error(`[RunwayProducer] Scene ${scene.scene_id} failed after retries:`, err.message);
      failed.push({ sceneId: scene.scene_id, clipPath: null, success: false, error: err.message });

      // On failure, reset chain to original asset so next scene still has a valid input
      currentInputUri = assetRunwayUri;
    }
  }

  const succeeded = clipPaths.filter((r) => r.success);

  if (succeeded.length === 0) {
    throw new Error('All scenes failed to generate. Please check your Runway API key and credits.');
  }

  if (failed.length > 0) {
    const partialError = new Error(
      `Partial failure: ${failed.length} of ${totalScenes} scenes failed (${failed.map((f) => `scene ${f.sceneId}`).join(', ')})`
    );
    partialError.code = 'PARTIAL_FAILURE';
    partialError.failedScenes = failed;
    partialError.succeededScenes = succeeded;
    partialError.clipPaths = succeeded.map((r) => r.clipPath);
    throw partialError;
  }

  return clipPaths.map((r) => r.clipPath);
}

/**
 * Extract the last frame of a video clip as a JPEG buffer,
 * then upload it to Runway ephemeral storage.
 *
 * Uses ffmpeg to seek to (duration - 0.1s) and extract one frame.
 *
 * @param {string} clipPath   - Local path to the video clip
 * @param {string} runwayKey  - User's Runway API key
 * @param {string} jobDir     - Job temp directory for intermediate files
 * @param {number} sceneId    - Scene ID (used for temp filename)
 * @returns {Promise<string>} runway:// URI of the uploaded frame
 */
async function extractAndUploadLastFrame(clipPath, runwayKey, jobDir, sceneId) {
  const framePath = path.join(jobDir, `frame_${sceneId}.jpg`);

  // Use ffmpeg to extract the last frame (seek to near end, grab 1 frame)
  await execFileAsync('ffmpeg', [
    '-sseof', '-0.5',          // seek 0.5s from end
    '-i', clipPath,
    '-vframes', '1',           // extract exactly 1 frame
    '-q:v', '2',               // high quality JPEG
    '-y',                      // overwrite if exists
    framePath,
  ]);

  const frameBuffer = await fs.readFile(framePath);

  // Clean up temp frame file
  await fs.unlink(framePath).catch(() => {});

  return uploadAsset(frameBuffer, 'image/jpeg', runwayKey);
}

/**
 * Process a single scene with retry logic.
 *
 * IMPORTANT: Retry only happens if the task was NEVER successfully submitted to Runway.
 * Once a task is submitted (create() succeeds), we do NOT retry — the task is already
 * running on Runway's side and retrying would create duplicate submissions and double billing.
 *
 * Retryable: network errors / timeouts BEFORE create() returns a task ID.
 * Not retryable: task submitted but failed (TASK_FAILED), content safety, invalid input.
 *
 * @param {object} scene
 * @param {string} runwayKey
 * @param {string} assetRunwayUri
 * @param {string} jobDir
 * @param {string} runwayModel
 * @param {boolean} isVideo
 * @param {number} maxRetries
 * @returns {Promise<string>} Local clip file path
 */
async function processSceneWithRetry(scene, runwayKey, assetRunwayUri, jobDir, runwayModel, isVideo, maxRetries) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const clipPath = await processScene(scene, runwayKey, assetRunwayUri, jobDir, runwayModel, isVideo);
      return clipPath;
    } catch (err) {
      lastError = err;

      // If task was already submitted to Runway, do NOT retry.
      // Retrying would create a new task — double submission + double billing.
      if (err.taskSubmitted) {
        console.warn(
          `[RunwayProducer] Scene ${scene.scene_id} task was submitted but failed — NOT retrying to avoid duplicate submission. Error: ${err.message}`
        );
        break;
      }

      const isRetryable = isRetryableError(err);

      console.warn(
        `[RunwayProducer] Scene ${scene.scene_id} attempt ${attempt}/${maxRetries} failed: ${err.message}` +
        (isRetryable ? ' (retrying pre-submit error...)' : ' (not retryable)')
      );

      if (!isRetryable || attempt === maxRetries) {
        break;
      }

      // Exponential backoff: 2s, 4s before retries
      await sleep(2000 * attempt);
    }
  }

  throw lastError;
}

/**
 * Process a single scene: call Runway API and download the clip.
 *
 * @param {object} scene
 * @param {string} runwayKey
 * @param {string} assetRunwayUri
 * @param {string} jobDir
 * @param {string} runwayModel
 * @param {boolean} isVideo
 * @returns {Promise<string>} Local clip file path
 */
async function processScene(scene, runwayKey, assetRunwayUri, jobDir, runwayModel, isVideo) {
  const client = buildClient(runwayKey);
  const outputPath = path.join(jobDir, `scene_${scene.scene_id}.mp4`);
  const prompt = scene.runway_parameters?.prompt || '';
  const duration = scene.duration || 5;


  let task;
  try {
    if (isVideo) {
      if (runwayModel === 'gen4_aleph') {
        task = await client.videoToVideo.create({
          model: 'gen4_aleph',
          videoUri: assetRunwayUri,
          promptText: prompt,
          ratio: '1280:720',
        }).waitForTaskOutput();
      } else {
        const seedanceDuration = duration >= 10 ? 10 : 5;
        task = await client.videoToVideo.create({
          model: 'seedance2',
          promptVideo: assetRunwayUri,
          promptText: prompt,
          duration: seedanceDuration,
        }).waitForTaskOutput();
      }
    } else {
      task = await client.imageToVideo.create({
        model: runwayModel,
        promptImage: assetRunwayUri,
        promptText: prompt,
        ratio: '1280:720',
        duration,
      }).waitForTaskOutput();
    }
  } catch (err) {
    // waitForTaskOutput() threw — task was already submitted to Runway.
    // Mark so retry logic skips re-submission.
    err.taskSubmitted = true;
    throw err;
  }

  if (!task.output || task.output.length === 0) {
    const noOutputErr = new Error(`Scene ${scene.scene_id}: Runway returned no output`);
    noOutputErr.taskSubmitted = true;
    throw noOutputErr;
  }

  await downloadClip(task.output[0], outputPath);
  return outputPath;
}

/**
 * Download a clip from a signed URL to a local file path.
 *
 * @param {string} signedUrl  - Runway signed URL for the generated clip
 * @param {string} outputPath - Local destination path
 * @returns {Promise<void>}
 */
export async function downloadClip(signedUrl, outputPath) {
  const response = await fetch(signedUrl);

  if (!response.ok) {
    throw new Error(`Failed to download clip: HTTP ${response.status} from ${signedUrl}`);
  }

  const writeStream = createWriteStream(outputPath);
  await pipeline(Readable.fromWeb(response.body), writeStream);
}

/**
 * Clean up the job directory after video delivery.
 * Should be called in a finally block.
 *
 * @param {string} jobId - Discord Thread ID
 * @returns {Promise<void>}
 */
export async function cleanupJobDir(jobId) {
  const jobDir = path.join(TEMP_BASE, jobId);
  try {
    await fs.rm(jobDir, { recursive: true, force: true });
    console.log(`[RunwayProducer] Cleaned up job dir: ${jobDir}`);
  } catch (err) {
    console.warn(`[RunwayProducer] Failed to clean up job dir ${jobDir}:`, err.message);
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Determine if an error from Runway is worth retrying.
 * SAFETY.INPUT.* errors are not retryable (content moderation, not refunded).
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryableError(err) {
  const msg = err.message || '';

  // Content safety failures — do not retry
  if (msg.includes('SAFETY.INPUT')) return false;

  // Invalid input — do not retry
  if (msg.includes('ASSET.INVALID')) return false;
  if (msg.includes('400')) return false;
  if (msg.includes('401')) return false;

  // Server errors, quality issues, output safety — retry
  return true;
}

/**
 * Sleep for a given number of milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
