/**
 * Error Handler module — centralised critical failure handling for VOX-Ads.
 *
 * Covers:
 *  - Invalid / expired API keys (req 18.1)
 *  - Runway credit exhaustion / TaskFailedError (req 18.2)
 *  - SAFETY.INPUT.* content moderation blocks (req 18.4 via runwayProducer)
 *  - Partial scene failures — stitch what succeeded (req 18.4)
 *  - Credit estimation before processing starts (req 18.4)
 *  - Job state persistence for resume capability (req 18.5)
 *
 * Requirements: 18.1, 18.2, 18.4, 18.5
 */

import { saveToDM, appendCreditLog } from './discordStorage.js';
import { updateProgress, editJobState, closeJobThread } from './queueManager.js';

// ─── Error Classification ─────────────────────────────────────────────────────

/**
 * Classify a raw error into a structured VOX error type.
 *
 * @param {Error} err
 * @returns {{ type: string, message: string, retryable: boolean }}
 */
export function classifyError(err) {
  const msg = err.message ?? '';
  const status = err.status ?? err.statusCode ?? 0;

  // Runway ephemeral upload requires credit purchase
  if (err.code === 'RUNWAY_NO_CREDITS' || msg.includes('credit purchase is required')) {
    return { type: 'RUNWAY_NO_CREDITS', message: msg, retryable: false };
  }

  // API key invalid / unauthorised
  if (
    status === 401 ||
    msg.includes('401') ||
    msg.includes('Unauthorized') ||
    msg.includes('Invalid API key') ||
    msg.includes('invalid api key') ||
    msg.includes('authentication')
  ) {
    return { type: 'INVALID_KEY', message: msg, retryable: false };
  }

  // Credit / quota exhausted
  if (
    status === 402 ||
    msg.includes('402') ||
    msg.includes('insufficient credits') ||
    msg.includes('credit') ||
    msg.includes('quota') ||
    msg.includes('billing')
  ) {
    return { type: 'CREDIT_EXHAUSTED', message: msg, retryable: false };
  }

  // Runway content safety block
  if (msg.includes('SAFETY.INPUT') || msg.includes('SAFETY.OUTPUT')) {
    return { type: 'SAFETY_BLOCK', message: msg, retryable: false };
  }

  // Partial scene failure (thrown by runwayProducer)
  if (err.code === 'PARTIAL_FAILURE') {
    return { type: 'PARTIAL_FAILURE', message: msg, retryable: false };
  }

  // Generic / unknown
  return { type: 'UNKNOWN', message: msg, retryable: true };
}

// ─── Credit Estimation ────────────────────────────────────────────────────────

/** Credit cost per second for each Runway model. */
const CREDIT_RATES = {
  'gen4.5': 12,
  'gen4_turbo': 5,
  'seedance2': 36,
  'gen4_aleph': 15,
};

/**
 * Estimate the total Runway credits required for a storyline.
 *
 * @param {object} storyline - Validated storyline JSON
 * @param {string} runwayModel - Runway model identifier
 * @returns {number} Estimated credit count
 */
export function estimateCredits(storyline, runwayModel) {
  const ratePerSec = CREDIT_RATES[runwayModel] ?? 12;
  const videoCredits = storyline.scenes.reduce(
    (sum, s) => sum + (s.duration || 5) * ratePerSec,
    0,
  );
  // Audio generation: ~2 credits
  return videoCredits + 2;
}

// ─── DM Notification Helpers ──────────────────────────────────────────────────

/**
 * Send a DM notification to the user about a critical failure.
 * Non-fatal — logs a warning if the DM cannot be sent.
 *
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @param {string} message
 */
async function notifyUserDM(client, userId, message) {
  try {
    const user = await client.users.fetch(userId);
    const dm = await user.createDM();
    await dm.send(message);
  } catch (dmErr) {
    console.warn(`[ErrorHandler] Could not send DM to ${userId}: ${dmErr.message}`);
  }
}

// ─── Critical Failure Handlers ────────────────────────────────────────────────

/**
 * Handle an invalid or expired API key.
 * Stops processing, notifies user via DM, instructs /configure.
 * Requirement 18.1
 *
 * @param {object} ctx
 * @param {import('discord.js').Client} ctx.client
 * @param {string} ctx.userId
 * @param {import('discord.js').ThreadChannel} ctx.thread
 * @param {string} ctx.jobId
 * @param {Error} ctx.err
 */
export async function handleInvalidKey({ client, userId, thread, jobId, err }) {
  const isGemini = err.message?.includes('Gemini');
  const service = isGemini ? 'Gemini' : 'Runway';

  const dmMessage =
`🔑 **${service} API Key is invalid or expired** (Job: \`${jobId}\`)\n\n` +
`Run \`/configure\` to update your API key.\n` +
`Error: \`${err.message}\``;

  await notifyUserDM(client, userId, dmMessage);

  await updateProgress(
    thread,
   `❌ **${service} API Key is invalid.** Check your DM for further instructions.`,
  ).catch(() => {});

  await closeJobThread(thread, `❌ Job canceled — API key is invalid.`).catch(() => {});
}

/**
 * Handle Runway credit exhaustion mid-processing.
 * Saves completed scenes to DM, notifies user with resume option.
 * Requirement 18.2
 *
 * @param {object} ctx
 * @param {import('discord.js').Client} ctx.client
 * @param {string} ctx.userId
 * @param {import('discord.js').ThreadChannel} ctx.thread
 * @param {string} ctx.stateMessageId
 * @param {string} ctx.jobId
 * @param {Error} ctx.err
 * @param {object} ctx.storyline
 * @param {string[]} ctx.completedScenes - Scene IDs that finished before credit ran out
 * @param {string} ctx.runwayModel
 */
export async function handleCreditExhausted({
  client,
  userId,
  thread,
  stateMessageId,
  jobId,
  err,
  storyline,
  completedScenes,
  runwayModel,
}) {
  // Persist resume state in thread
  await editJobState(thread, stateMessageId, {
    status: 'paused_credit',
    scenes_completed: completedScenes,
    scenes_pending: storyline.scenes
      .map((s) => s.scene_id)
      .filter((id) => !completedScenes.includes(id)),
    paused_at: new Date().toISOString(),
  }).catch(() => {});

  // Save partial progress to user DM for resume capability
  await saveToDM(client, userId, 'JOB_RESUME', {
    job_id: jobId,
    scenes_completed: completedScenes,
    scenes_total: storyline.scenes.length,
    storyline_title: storyline.title ?? 'VOX Ad',
    paused_reason: 'credit_exhausted',
    paused_at: new Date().toISOString(),
  }).catch((dmErr) => {
    console.warn(`[ErrorHandler] Failed to save resume state to DM: ${dmErr.message}`);
  });

  const completedCount = completedScenes.length;
  const totalCount = storyline.scenes.length;

  const dmMessage =
  `💳 **Runway credits ran out mid-process** (Job: \`${jobId}\`)\n\n` +
`Saved progress: **${completedCount}/${totalCount} scene** completed.\n` +
`Refill your Runway credits, then contact the admin to continue this job.\n\n` +
`Error: \`${err.message}\``;

  await notifyUserDM(client, userId, dmMessage);

  await updateProgress(
    thread,
`💳 **Runway Credits are out.** ${completedCount}/${totalCount} scenes saved. Check DM for more options.`,
  ).catch(() => {});

  await closeJobThread(
    thread,
`⏸️ Job paused — credits expired. ${completedCount}/${totalCount} completed scenes.`,
  ).catch(() => {});
}

/**
 * Handle a Runway SAFETY.INPUT.* content moderation block.
 * Notifies user to modify their content and re-run.
 * Requirement 18.4
 *
 * @param {object} ctx
 * @param {import('discord.js').Client} ctx.client
 * @param {string} ctx.userId
 * @param {import('discord.js').ThreadChannel} ctx.thread
 * @param {string} ctx.jobId
 * @param {Error} ctx.err
 */
export async function handleSafetyBlock({ client, userId, thread, jobId, err }) {
  const dmMessage =
`🚫 **Content blocked by Runway moderation** (Job: \`${jobId}\`)\n\n` +
`Your asset or prompt violates Runway's content policies.\n` +
`Change your image/video or ad description, then try again with \`/ads\`.\n\n` +
`Details: \`${err.message}\``;

  await notifyUserDM(client, userId, dmMessage);

  await updateProgress(
    thread,
`🚫 **Content blocked.** Check your DM for details and further instructions.`,
  ).catch(() => {});

  await closeJobThread(thread, `🚫 Job canceled — content blocked.`).catch(() => {});
}

/**
 * Handle partial scene failure — stitch successful scenes and notify about skipped ones.
 * Requirement 18.4
 *
 * @param {object} ctx
 * @param {import('discord.js').ThreadChannel} ctx.thread
 * @param {Error} ctx.err - Must have err.code === 'PARTIAL_FAILURE'
 * @returns {{ clipPaths: string[], failedScenes: object[] }}
 */
export function extractPartialResults(err) {
  if (err.code !== 'PARTIAL_FAILURE') {
    throw new Error('extractPartialResults called with non-partial error');
  }
  return {
    clipPaths: err.clipPaths ?? [],
    failedScenes: err.failedScenes ?? [],
    succeededScenes: err.succeededScenes ?? [],
  };
}

/**
 * Build a user-facing message describing which scenes were skipped.
 *
 * @param {object[]} failedScenes
 * @returns {string}
 */
export function buildPartialFailureNotice(failedScenes) {
  const ids = failedScenes.map((s) => `Scene ${s.sceneId}`).join(', ');
  return (
`⚠️ **Partial production successful.**\n` +
`Skipped scenes: ${ids}\n` +
`Video delivered with only successful scenes.`
  );
}

// ─── Top-Level Pipeline Error Router ─────────────────────────────────────────

/**
 * Route a pipeline error to the appropriate handler.
 * Returns true if the error was handled as a critical failure,
 * false if it should be treated as a generic error.
 *
 * @param {object} ctx
 * @param {import('discord.js').Client} ctx.client
 * @param {string} ctx.userId
 * @param {import('discord.js').ThreadChannel} ctx.thread
 * @param {string} ctx.stateMessageId
 * @param {string} ctx.jobId
 * @param {Error} ctx.err
 * @param {object} ctx.storyline
 * @param {string[]} ctx.completedScenes
 * @param {string} ctx.runwayModel
 * @param {number} ctx.runwayCreditsUsed
 * @param {number} ctx.geminiTokensUsed
 * @returns {Promise<boolean>} true if handled as critical failure
 */
export async function routePipelineError(ctx) {
  const { err, client, userId, thread, stateMessageId, jobId, storyline, completedScenes, runwayModel, runwayCreditsUsed, geminiTokensUsed } = ctx;
  const classified = classifyError(err);

  // Log failed credit usage regardless of error type
  if (runwayCreditsUsed > 0) {
    await appendCreditLog(client, userId, {
      job_id: jobId,
      runway_credits_used: runwayCreditsUsed,
      gemini_tokens_used: geminiTokensUsed,
      scenes_processed: completedScenes.length,
      runway_model: runwayModel,
      status: 'failed',
    }).catch(() => {});
  }

  switch (classified.type) {
    case 'INVALID_KEY':
      await handleInvalidKey({ client, userId, thread, jobId, err });
      return true;

    case 'RUNWAY_NO_CREDITS':
      await updateProgress(thread,
        `💳 **Runway account requires credits.** Top up at https://app.runwayml.com/settings/credits`
      ).catch(() => {});
      await closeJobThread(thread, '❌ Job canceled — Runway account has no credits.').catch(() => {});
      await notifyUserDM(client, userId,
        `💳 **Runway account requires credits** (Job: \`${jobId}\`)\n\n${err.message}`
      );
      return true;

    case 'CREDIT_EXHAUSTED':
      await handleCreditExhausted({
        client, userId, thread, stateMessageId, jobId, err,
        storyline, completedScenes, runwayModel,
      });
      return true;

    case 'SAFETY_BLOCK':
      await handleSafetyBlock({ client, userId, thread, jobId, err });
      return true;

    default:
      return false;
  }
}
