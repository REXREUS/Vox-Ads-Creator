/**
 * Gemini Director module.
 *
 * Uses Google Gemini AI (@google/genai SDK) to:
 * 1. Analyze product assets (image/video) via multimodal Vision
 * 2. Generate structured JSON storylines for Runway video production
 * 3. Validate and retry on malformed JSON output
 *
 * All functions accept `geminiModel` as a parameter (default: 'gemini-2.5-flash').
 */

import { GoogleGenAI } from '@google/genai';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { validateStorylineJSON } from '../utils/validator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_PATH = join(__dirname, '../prompts/director_system_prompt.md');

const DEFAULT_MODEL = 'gemini-2.5-flash';

// Inline data size limits — above these, use Gemini File API upload
const INLINE_LIMIT_IMAGE_BYTES = 4 * 1024 * 1024;   // 4 MB (safe margin under 5MB limit)
const INLINE_LIMIT_VIDEO_BYTES = 15 * 1024 * 1024;  // 15 MB (safe margin under 20MB limit)

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';

/** Cache the system prompt after first read */
let _systemPromptCache = null;

/**
 * Extract a concise, human-readable message from a Gemini SDK error.
 * The SDK often puts the full JSON response body in err.message.
 *
 * @param {Error} err
 * @returns {string}
 */
function extractGeminiError(err) {
  const raw = err.message ?? String(err);
  // Try to parse JSON error body from the SDK
  try {
    // The SDK sometimes wraps the JSON in the message directly
    const jsonStart = raw.indexOf('{');
    if (jsonStart !== -1) {
      const parsed = JSON.parse(raw.slice(jsonStart));
      const msg = parsed?.error?.message ?? parsed?.message;
      if (msg) {
        // Return just the first line — Gemini errors have useful info on line 1
        return msg.split('\n')[0].slice(0, 300);
      }
    }
  } catch {
    // Not JSON — fall through
  }
  // Plain text error — truncate to 300 chars
  return raw.slice(0, 300);
}

/**
 * Load the director system prompt from disk (cached after first call).
 * @returns {Promise<string>}
 */
async function loadSystemPrompt() {
  if (!_systemPromptCache) {
    _systemPromptCache = await readFile(SYSTEM_PROMPT_PATH, 'utf8');
  }
  return _systemPromptCache;
}

/**
 * Build a GoogleGenAI client with the user's Gemini API key.
 * @param {string} geminiKey
 * @returns {GoogleGenAI}
 */
function buildClient(geminiKey) {
  return new GoogleGenAI({ apiKey: geminiKey });
}

/**
 * Build a Gemini content part for an asset.
 * Uses inlineData for small files; uploads via Gemini File API REST for large files
 * to avoid "Invalid string length" errors with base64 encoding.
 *
 * @param {Buffer} assetBuffer
 * @param {string} mimeType
 * @param {string} geminiKey
 * @returns {Promise<object>} Gemini content part
 */
async function buildAssetPart(assetBuffer, mimeType, geminiKey) {
  const isVideo = mimeType.startsWith('video/');
  const inlineLimit = isVideo ? INLINE_LIMIT_VIDEO_BYTES : INLINE_LIMIT_IMAGE_BYTES;

  if (assetBuffer.length <= inlineLimit) {
    return {
      inlineData: {
        mimeType,
        data: assetBuffer.toString('base64'),
      },
    };
  }

  // File too large for inline — upload via Gemini File API
  console.log(`[GeminiDirector] Asset ${(assetBuffer.length / 1024 / 1024).toFixed(1)}MB exceeds inline limit, uploading via File API...`);

  const fileUri = await uploadToGeminiFileApi(assetBuffer, mimeType, geminiKey);

  return {
    fileData: {
      mimeType,
      fileUri,
    },
  };
}

/**
 * Upload a file to Gemini File API via multipart REST upload.
 * Returns the file URI for use in generateContent calls.
 *
 * @param {Buffer} assetBuffer
 * @param {string} mimeType
 * @param {string} geminiKey
 * @returns {Promise<string>} Gemini file URI (e.g. "https://generativelanguage.googleapis.com/v1beta/files/...")
 */
async function uploadToGeminiFileApi(assetBuffer, mimeType, geminiKey) {
  const numBytes = assetBuffer.length;
  const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
  const displayName = `vox_asset.${ext}`;

  // Step 1: Initiate resumable upload
  const initRes = await fetch(
    `${GEMINI_API_BASE}/upload/v1beta/files?uploadType=resumable&key=${geminiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(numBytes),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
  );

  if (!initRes.ok) {
    const body = await initRes.text();
    throw new Error(`Gemini File API init failed (${initRes.status}): ${body}`);
  }

  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini File API did not return an upload URL');
  }

  // Step 2: Upload the file bytes
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(numBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: assetBuffer,
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`Gemini File API upload failed (${uploadRes.status}): ${body}`);
  }

  const fileInfo = await uploadRes.json();
  const uri = fileInfo?.file?.uri;
  if (!uri) {
    throw new Error(`Gemini File API returned no URI: ${JSON.stringify(fileInfo)}`);
  }

  console.log(`[GeminiDirector] File uploaded: ${uri}`);
  return uri;
}

/**
 * Analyze a product asset using Gemini Vision (multimodal).
 * Returns a textual description of the asset's visual characteristics.
 *
 * @param {Buffer} assetBuffer - Raw file buffer
 * @param {string} mimeType    - MIME type (e.g. 'image/jpeg', 'video/mp4')
 * @param {string} geminiKey   - User's Gemini API key
 * @param {string} [geminiModel] - Gemini model to use (default: 'gemini-2.5-flash')
 * @returns {Promise<string>} Textual analysis of the asset
 */
export async function analyzeAsset(assetBuffer, mimeType, geminiKey, geminiModel = DEFAULT_MODEL) {
  const ai = buildClient(geminiKey);
  const assetPart = await buildAssetPart(assetBuffer, mimeType, geminiKey);

  try {
    const response = await ai.models.generateContent({
      model: geminiModel,
      contents: [
        {
          parts: [
            assetPart,
            {
              text: `Analyze this product asset for advertising purposes. Describe:
1. The product type and key visual characteristics
2. Dominant colors, textures, and materials
3. Lighting conditions and mood
4. Any text, logos, or branding visible
5. Suggested advertising angles or emotional hooks

Be concise and specific. This analysis will be used to generate a professional video ad storyline.`,
            },
          ],
        },
      ],
    });

    return response.text;
  } catch (err) {
    throw new Error(extractGeminiError(err));
  }
}

/**
 * Perform a content safety check on the asset and concept.
 * Returns null if safe, or an error message string if unsafe.
 *
 * @param {Buffer} assetBuffer
 * @param {string} mimeType
 * @param {string} concept - Ad concept text from user
 * @param {string} geminiKey
 * @param {string} [geminiModel]
 * @returns {Promise<string|null>} null if safe, error message if unsafe
 */
export async function checkContentSafety(assetBuffer, mimeType, concept, geminiKey, geminiModel = DEFAULT_MODEL) {
  const ai = buildClient(geminiKey);
  const assetPart = await buildAssetPart(assetBuffer, mimeType, geminiKey);

  try {
    const response = await ai.models.generateContent({
      model: geminiModel,
      contents: [
        {
          parts: [
            assetPart,
            {
              text: `Review this asset and ad concept for content safety.

Ad concept: "${concept}"

Check for: violence, explicit sexual content, hate speech, illegal activity, dangerous products, or content targeting minors inappropriately.

Respond with ONLY one of:
- "SAFE" if the content is appropriate for general advertising
- "UNSAFE: <brief reason>" if the content violates safety guidelines`,
            },
          ],
        },
      ],
    });

    const result = response.text.trim();
    if (result.startsWith('UNSAFE')) {
      return result.replace('UNSAFE: ', '');
    }
    return null;
  } catch (err) {
    throw new Error(extractGeminiError(err));
  }
}

/**
 * Generate a complete video ad storyline from asset + form parameters.
 * Includes automatic retry with corrective prompt if JSON validation fails.
 *
 * @param {object} params
 * @param {Buffer} params.assetBuffer       - Raw asset file buffer
 * @param {string} params.mimeType          - Asset MIME type
 * @param {string} params.assetAnalysis     - Output from analyzeAsset()
 * @param {string} params.concept           - Ad concept from user
 * @param {string} params.targetAudience    - Target audience description
 * @param {string} params.ageRange          - Target age range
 * @param {string} params.theme             - Emotional theme/tone
 * @param {number} params.duration          - Total video duration in seconds
 * @param {string} params.stylePreset       - Style preset key or 'auto'
 * @param {boolean} params.watermark        - Whether watermark will be added
 * @param {boolean} params.verbose          - Whether verbose JSON output is requested
 * @param {object} [params.presetParams]    - Resolved preset parameters (from stylePresets.js)
 * @param {string} geminiKey                - User's Gemini API key
 * @param {string} [geminiModel]            - Gemini model to use
 * @returns {Promise<object>} Validated storyline JSON object
 */
export async function generateStoryline(params, geminiKey, geminiModel = DEFAULT_MODEL) {
  const systemPrompt = await loadSystemPrompt();
  const ai = buildClient(geminiKey);

  // Build asset part once — reused for both attempts (avoids double upload)
  const assetPart = await buildAssetPart(params.assetBuffer, params.mimeType, geminiKey);
  const briefText = buildBriefText(params);

  try {
    // First attempt
    let response = await ai.models.generateContent({
      model: geminiModel,
      contents: [{ parts: [assetPart, { text: briefText }] }],
      config: { systemInstruction: systemPrompt },
    });

    let rawText = response.text.trim();

    try {
      return parseStorylineResponse(rawText);
    } catch (firstError) {
      console.warn(`[Gemini Director] First attempt failed: ${firstError.message}. Retrying with corrective prompt...`);

      const correctivePrompt = buildCorrectivePrompt(rawText, firstError.message, briefText);

      response = await ai.models.generateContent({
        model: geminiModel,
        contents: [{ parts: [assetPart, { text: correctivePrompt }] }],
        config: { systemInstruction: systemPrompt },
      });

      rawText = response.text.trim();
      return parseStorylineResponse(rawText);
    }
  } catch (err) {
    // Re-throw parse/validation errors as-is; clean up SDK API errors
    if (err.message?.startsWith('INVALID_JSON') || err.message?.startsWith('INVALID_STORYLINE')) throw err;
    throw new Error(extractGeminiError(err));
  }
}

/**
 * Regenerate a storyline with optional user feedback.
 * Includes automatic retry with corrective prompt if JSON validation fails.
 *
 * @param {object} params - Same as generateStoryline params
 * @param {string} feedback - User feedback for regeneration
 * @param {string} geminiKey
 * @param {string} [geminiModel]
 * @returns {Promise<object>} New validated storyline JSON object
 */
export async function regenerateStoryline(params, feedback, geminiKey, geminiModel = DEFAULT_MODEL) {
  const systemPrompt = await loadSystemPrompt();
  const ai = buildClient(geminiKey);

  const assetPart = await buildAssetPart(params.assetBuffer, params.mimeType, geminiKey);
  const briefText = buildBriefText(params);

  const fullPrompt = `${briefText}

USER FEEDBACK FOR REGENERATION:
${feedback}

Please generate a new storyline that addresses this feedback while maintaining all quality standards.`;

  try {
    // First attempt
    let response = await ai.models.generateContent({
      model: geminiModel,
      contents: [{ parts: [assetPart, { text: fullPrompt }] }],
      config: { systemInstruction: systemPrompt },
    });

    let rawText = response.text.trim();

    try {
      return parseStorylineResponse(rawText);
    } catch (firstError) {
      console.warn(`[Gemini Director] Regeneration failed: ${firstError.message}. Retrying with corrective prompt...`);

      const correctivePrompt = buildCorrectivePrompt(rawText, firstError.message, fullPrompt);

      response = await ai.models.generateContent({
        model: geminiModel,
        contents: [{ parts: [assetPart, { text: correctivePrompt }] }],
        config: { systemInstruction: systemPrompt },
      });

      rawText = response.text.trim();
      return parseStorylineResponse(rawText);
    }
  } catch (err) {
    if (err.message?.startsWith('INVALID_JSON') || err.message?.startsWith('INVALID_STORYLINE')) throw err;
    throw new Error(extractGeminiError(err));
  }
}

/**
 * Edit a specific scene in an existing storyline without full regeneration.
 *
 * @param {object} storyline - Existing storyline JSON object
 * @param {number} sceneId   - 1-indexed scene ID to edit
 * @param {object} changes   - Fields to update (e.g. { prompt: '...' })
 * @param {string} geminiKey
 * @param {string} [geminiModel]
 * @returns {Promise<object>} Updated storyline JSON object
 */
export async function editScene(storyline, sceneId, changes, geminiKey, geminiModel = DEFAULT_MODEL) {
  const ai = buildClient(geminiKey);

  const sceneIndex = storyline.scenes.findIndex(s => s.scene_id === sceneId);
  if (sceneIndex === -1) {
    throw new Error(`Scene ${sceneId} not found in storyline`);
  }

  const currentScene = storyline.scenes[sceneIndex];

  let response;
  try {
    response = await ai.models.generateContent({
      model: geminiModel,
      contents: [
        {
          parts: [
            {
              text: `You are editing a single scene in a video ad storyline.

CURRENT SCENE:
${JSON.stringify(currentScene, null, 2)}

VISUAL SEED (must be preserved in all prompts):
${storyline.visual_seed}

REQUESTED CHANGES:
${JSON.stringify(changes, null, 2)}

Return ONLY the updated scene as a valid JSON object with the same structure. 
Preserve all fields not mentioned in the changes.
Ensure the prompt still includes the visual_seed phrase.
No markdown, no explanation — just the JSON object.`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    throw new Error(extractGeminiError(err));
  }

  const rawText = response.text.trim();
  let updatedScene;
  try {
    // Strip markdown fences if present
    const cleaned = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    updatedScene = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Gemini returned invalid JSON for scene edit: ${err.message}`);
  }

  const updatedStoryline = {
    ...storyline,
    scenes: storyline.scenes.map((scene, idx) =>
      idx === sceneIndex ? { ...scene, ...updatedScene } : scene
    ),
  };

  return updatedStoryline;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Detect the language of a text string using a simple heuristic based on
 * Unicode character ranges. Returns a BCP-47 language tag and display name.
 *
 * Falls back to 'en' (English) if detection is inconclusive.
 *
 * @param {string} text
 * @returns {{ code: string, name: string }}
 */
function detectLanguage(text) {
  if (!text || text.trim().length === 0) return { code: 'en', name: 'English' };

  const sample = text.slice(0, 200);

  // Count characters by script
  const cjkChars    = (sample.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;   // Chinese/Japanese Kanji
  const kanaChars   = (sample.match(/[\u3040-\u30ff]/g) || []).length;                // Hiragana/Katakana
  const hangulChars = (sample.match(/[\uac00-\ud7af]/g) || []).length;                // Korean
  const arabicChars = (sample.match(/[\u0600-\u06ff]/g) || []).length;                // Arabic
  const cyrillicChars = (sample.match(/[\u0400-\u04ff]/g) || []).length;              // Russian/Cyrillic
  const thaiChars   = (sample.match(/[\u0e00-\u0e7f]/g) || []).length;                // Thai
  const devaChars   = (sample.match(/[\u0900-\u097f]/g) || []).length;                // Hindi/Devanagari
  const latinChars  = (sample.match(/[a-zA-ZÀ-ÖØ-öø-ÿ]/g) || []).length;            // Latin (EN/ID/ES/FR/etc)

  const total = sample.replace(/\s/g, '').length || 1;

  if (kanaChars / total > 0.1) return { code: 'ja', name: 'Japanese' };
  if (hangulChars / total > 0.1) return { code: 'ko', name: 'Korean' };
  if (cjkChars / total > 0.1) return { code: 'zh', name: 'Chinese' };
  if (arabicChars / total > 0.1) return { code: 'ar', name: 'Arabic' };
  if (cyrillicChars / total > 0.1) return { code: 'ru', name: 'Russian' };
  if (thaiChars / total > 0.1) return { code: 'th', name: 'Thai' };
  if (devaChars / total > 0.1) return { code: 'hi', name: 'Hindi' };

  // Latin script — try to distinguish Indonesian vs English by common words
  const lower = sample.toLowerCase();
  const idWords = ['dan', 'yang', 'untuk', 'dengan', 'adalah', 'ini', 'itu', 'dari', 'ke', 'di', 'pada', 'kami', 'kita', 'produk', 'anda'];
  const idMatches = idWords.filter(w => lower.includes(w)).length;
  if (idMatches >= 2) return { code: 'id', name: 'Indonesian' };

  return { code: 'en', name: 'English' };
}

/**
 * Build the creative brief text to send to Gemini.
 * @param {object} params
 * @returns {string}
 */
function buildBriefText(params) {
  const presetInfo = params.presetParams && !params.presetParams.auto
    ? `
STYLE PRESET PARAMETERS (use these as foundation):
- Visual Seed: ${params.presetParams.visual_seed}
- Relighting: ${params.presetParams.relighting.source} at intensity ${params.presetParams.relighting.intensity}
- Camera Motion: ${params.presetParams.virtual_camera.motion} at speed ${params.presetParams.virtual_camera.speed}
- Audio Mood: ${params.presetParams.audio_mood}`
    : '';

  // Detect language from user's concept input — all narration must use this language
  const lang = detectLanguage(params.concept);

  return `CREATIVE BRIEF:
- Concept: ${params.concept}
- Target Audience: ${params.targetAudience}
- Age Range: ${params.ageRange}
- Theme: ${params.theme}
- Total Duration: ${params.duration} seconds
- Number of Scenes: ${params.numScenes ?? 6}
- Style Preset: ${params.stylePreset}
- Watermark: ${params.watermark ? 'Yes' : 'No'}
- Narration Language: ${lang.name} (${lang.code}) — ALL scenes must use this language
${presetInfo}

ASSET ANALYSIS:
${params.assetAnalysis}

IMPORTANT — NARRATION LANGUAGE LOCK:
ALL narration_text fields across ALL scenes MUST be written in ${lang.name} (${lang.code}).
Do NOT switch languages between scenes under any circumstances.
Every single scene's narration_text must be in ${lang.name} only.

IMPORTANT — AUDIO MOOD:
Choose audio_mood that is emotionally appropriate for THIS specific product and concept.
A funeral product needs somber music. A children's toy needs gentle playful music.
Never default to generic "upbeat" — match the product's emotional context precisely.

IMPORTANT — NARRATION SYNC:
Write narration_text AFTER writing the scene's runway_parameters.prompt.
The narration must directly reflect the KEY VISUAL ACTION in that scene's prompt.
If the scene shows "perfume being sprayed", narration must be about that moment — not a generic product claim.

IMPORTANT — IMAGE CHAINING PIPELINE:
Scene 1 receives the original product asset as input.
Scene 2 receives the LAST FRAME of Scene 1 as its input image.
Scene 3 receives the last frame of Scene 2, and so on.
Write each scene's prompt as a visual continuation from the previous scene's \`scene_end_state\`.
Each \`scene_end_state\` must precisely describe the final frame so the next scene can continue naturally.

Generate a complete video ad storyline JSON for this product. Follow all rules in the system prompt exactly.`;
}

/**
 * Build a corrective prompt for retry when the first response was invalid.
 * @param {string} previousOutput - The invalid output from the first attempt
 * @param {string} errorMessage   - Validation error message
 * @param {string} originalPrompt - The original brief text
 * @returns {string}
 */
function buildCorrectivePrompt(previousOutput, errorMessage, originalPrompt) {
  return `${originalPrompt}

IMPORTANT: Your previous response had errors and must be corrected.

PREVIOUS INVALID RESPONSE:
${previousOutput.slice(0, 500)}${previousOutput.length > 500 ? '...' : ''}

VALIDATION ERRORS:
${errorMessage}

Please generate a corrected, complete JSON storyline that:
1. Is valid JSON with no markdown fences or extra text
2. Has a "scenes" array with the correct number of scenes
3. Has "total_duration" matching the sum of all scene durations
4. Has "runway_parameters.prompt" in every scene
5. Includes the visual_seed phrase in every scene prompt`;
}

/**
 * Parse and validate a raw JSON string from Gemini.
 * Strips markdown fences if present.
 *
 * @param {string} rawText
 * @returns {object} Validated storyline
 * @throws {Error} If JSON is invalid or fails validation
 */
function parseStorylineResponse(rawText) {
  // Strip markdown code fences if Gemini wrapped the JSON
  const cleaned = rawText
    .replace(/^```(?:json)?\n?/m, '')
    .replace(/\n?```$/m, '')
    .trim();

  // Check for content safety error response
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`INVALID_JSON: ${err.message}`);
  }

  if (parsed.error === 'CONTENT_SAFETY') {
    const safetyError = new Error(parsed.message || 'Content safety check failed');
    safetyError.code = 'CONTENT_SAFETY';
    throw safetyError;
  }

  const { valid, errors } = validateStorylineJSON(parsed);
  if (!valid) {
    throw new Error(`INVALID_STORYLINE: ${errors.join('; ')}`);
  }

  // Warn if narration languages appear inconsistent (non-fatal — log only)
  if (parsed.scenes) {
    const narrations = parsed.scenes
      .map(s => s.narration_text)
      .filter(Boolean);

    if (narrations.length > 1) {
      const detectedLangs = narrations.map(t => detectLanguage(t).code);
      const uniqueLangs = [...new Set(detectedLangs)];
      if (uniqueLangs.length > 1) {
        console.warn(`[GeminiDirector] Narration language inconsistency detected across scenes: ${detectedLangs.join(', ')} — Gemini may have mixed languages`);
      }
    }
  }

  return parsed;
}