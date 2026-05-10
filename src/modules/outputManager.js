/**
 * Output Manager module.
 *
 * Orchestrates FFmpeg post-production by spawning ffmpeg_worker.py as a
 * child process, and sanitizes storyline JSON before sending to Discord.
 *
 * Requirements: 5.1, 5.3, 15.3
 */

import { spawn } from 'child_process';
import path from 'path';

const PYTHON_PATH = process.env.PYTHON_PATH || 'python3';
const WORKERS_PATH = process.env.WORKERS_PATH
  ? path.resolve(process.env.WORKERS_PATH)
  : path.resolve('src/workers');

/**
 * Stitch scene clips into a final .mp4 by spawning ffmpeg_worker.py.
 *
 * @param {string[]} scenePaths - Ordered array of local clip file paths
 * @param {object}  storyline   - Validated storyline JSON (used for transition metadata)
 * @param {object}  [options]
 * @param {string}  [options.outputPath]      - Destination path for the final .mp4
 * @param {string}  [options.watermark]       - Watermark text to overlay (omit to skip)
 * @param {string}  [options.audioPath]       - Path to background audio file (omit to skip)
 * @param {(string|null)[]} [options.narrationPaths] - Ordered narration audio paths per scene (null = no narration)
 * @param {boolean} [options.isVideoInput]    - True if original asset was a video (strips original clip audio)
 * @returns {Promise<string>} Absolute path to the rendered .mp4 file
 */
export async function stitchScenes(scenePaths, storyline, options = {}) {
  const { outputPath, watermark, audioPath, narrationPaths, isVideoInput = false } = options;

  if (!outputPath) {
    throw new Error('outputPath is required in options');
  }

  if (!scenePaths || scenePaths.length === 0) {
    throw new Error('No scene paths provided for stitching');
  }

  const workerScript = path.join(WORKERS_PATH, 'ffmpeg_worker.py');

  const args = [
    workerScript,
    '--clips', JSON.stringify(scenePaths),
    '--storyline', JSON.stringify(storyline),
    '--output', outputPath,
  ];

  if (watermark) {
    args.push('--watermark', watermark);
  }

  if (audioPath) {
    args.push('--audio', audioPath);
  }

  // Pass narration paths only if at least one scene has narration
  if (narrationPaths && narrationPaths.some(Boolean)) {
    args.push('--narrations', JSON.stringify(narrationPaths));
  }

  // Tell FFmpeg worker to strip original video audio to avoid 3-way collision
  if (isVideoInput) {
    args.push('--is_video_input');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn ffmpeg_worker.py: ${err.message}`));
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        // Try to read the full debug log written by run_ffmpeg() for the real error
        let debugContent = '';
        try {
          const { readFile: fsRead } = await import('fs/promises');
          debugContent = await fsRead('/tmp/vox_ffmpeg_debug.log', 'utf8');
        } catch {
          // Debug file not available — fall back to stderr parsing
        }

        const rawText = debugContent || stderr;
        const lines = rawText.trim().split('\n');

        // Filter out metadata/noise lines
        const isNoise = (l) => {
          const s = l.trim();
          if (!s) return true;
          // FFmpeg metadata key-value: "    handler_name    : VideoHandler"
          if (/^\s+[\w][\w\s_]+\s*:\s*/.test(l) && !/error|invalid|failed|cannot/i.test(l)) return true;
          const NOISE_STARTS = [
            'frame=', 'fps=', 'size=', 'time=', 'bitrate=', 'speed=',
            'Stream #', 'Input #', 'Output #', 'ffmpeg version', 'built with',
            'configuration:', 'lib', 'Metadata:', 'Duration:', 'Chapter',
            'video:', 'audio:', 'muxing overhead', 'global headers',
          ];
          return NOISE_STARTS.some((p) => s.startsWith(p));
        };

        const meaningful = lines.filter((l) => !isNoise(l));
        const errorLines = meaningful.filter((l) =>
          /error|invalid|failed|cannot|no such|permission denied|unrecognized|moov atom/i.test(l)
        );

        let summary;
        if (errorLines.length > 0) {
          summary = errorLines.slice(-5).join('\n').trim();
        } else if (meaningful.length > 0) {
          summary = meaningful.slice(-8).join('\n').trim();
        } else {
          summary = `FFmpeg worker exited with code ${code}`;
        }

        summary = summary
          .replace(/^.*RuntimeError:\s*FFmpeg failed:\s*/im, '')
          .replace(/^.*RuntimeError:\s*/im, '')
          .replace(/^.*Processing failed:\s*/im, '')
          .trim();

        const err = new Error(summary || `FFmpeg worker exited with code ${code}`);
        err.code = 'FFMPEG_WORKER_ERROR';
        err.exitCode = code;
        err.rawStderr = stderr.slice(-2000); // attach for logging
        reject(err);
        return;
      }

      const resultPath = stdout.trim().split('\n').pop()?.trim() ?? '';
      if (!resultPath) {
        reject(new Error('ffmpeg_worker.py produced no output path'));
        return;
      }
      if (!resultPath.endsWith('.mp4')) {
        reject(new Error(`ffmpeg_worker.py returned unexpected output: ${resultPath.slice(0, 200)}`));
        return;
      }

      resolve(resultPath);
    });
  });
}

// ─── Sensitive field patterns ─────────────────────────────────────────────────

/**
 * Top-level keys in the storyline that should never be sent to a public channel.
 * Extend this list if new sensitive fields are added to the data model.
 */
const SENSITIVE_TOP_LEVEL_KEYS = new Set([
  'gemini_key',
  'runway_key',
  'api_key',
  'apiKey',
  'token',
  'secret',
  'password',
  'credential',
  'credentials',
]);

/**
 * Keys inside runway_parameters (or any nested object) that are sensitive.
 */
const SENSITIVE_NESTED_KEYS = new Set([
  'api_key',
  'apiKey',
  'token',
  'secret',
  'password',
  'credential',
  'credentials',
  'gemini_key',
  'runway_key',
]);

/**
 * Recursively remove sensitive fields from an object.
 *
 * @param {unknown} value - Any JSON-serialisable value
 * @param {Set<string>} sensitiveKeys - Set of key names to strip
 * @returns {unknown} Sanitised deep copy
 */
function deepClean(value, sensitiveKeys) {
  if (Array.isArray(value)) {
    return value.map((item) => deepClean(item, sensitiveKeys));
  }

  if (value !== null && typeof value === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(value)) {
      if (sensitiveKeys.has(k)) continue;
      cleaned[k] = deepClean(v, sensitiveKeys);
    }
    return cleaned;
  }

  return value;
}

/**
 * Return a sanitised copy of the storyline JSON safe for public Discord channels.
 *
 * Removes all fields that could contain API keys, tokens, or credentials —
 * both at the top level and recursively within nested objects.
 *
 * @param {object} storyline - Raw storyline JSON (may contain sensitive fields)
 * @returns {object} Deep copy with all sensitive fields removed
 */
export function cleanVerboseJSON(storyline) {
  if (!storyline || typeof storyline !== 'object') {
    return storyline;
  }

  // Combine both sets for a single recursive pass
  const allSensitiveKeys = new Set([...SENSITIVE_TOP_LEVEL_KEYS, ...SENSITIVE_NESTED_KEYS]);
  return deepClean(storyline, allSensitiveKeys);
}
