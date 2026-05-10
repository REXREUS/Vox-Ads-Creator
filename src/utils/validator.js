/**
 * JSON validation utilities for VOX-Ads Creator storyline output.
 * Validates the structure produced by Gemini Director before passing to Runway Producer.
 */

/**
 * Validate a storyline JSON object produced by Gemini Director.
 *
 * Checks:
 * - `scenes` is a non-empty array
 * - `total_duration` is a positive number
 * - Sum of scene durations matches `total_duration` (±1 second tolerance)
 * - Each scene has `scene_id`, `duration`, and `runway_parameters.prompt`
 *
 * @param {unknown} json - Parsed JSON object to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateStorylineJSON(json) {
  const errors = [];

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { valid: false, errors: ['Storyline must be a JSON object'] };
  }

  // Validate title — must be present and non-empty
  if (!json.title || typeof json.title !== 'string' || json.title.trim() === '') {
    errors.push('Missing or empty "title" field');
  }

  // Validate scenes array
  if (!Array.isArray(json.scenes)) {
    errors.push('Missing or invalid "scenes" array');
  } else if (json.scenes.length === 0) {
    errors.push('"scenes" array must not be empty');
  } else {
    // Validate each scene
    json.scenes.forEach((scene, index) => {
      const prefix = `Scene[${index}]`;

      if (scene === null || typeof scene !== 'object') {
        errors.push(`${prefix}: must be an object`);
        return;
      }

      if (scene.scene_id === undefined || scene.scene_id === null) {
        errors.push(`${prefix}: missing "scene_id"`);
      }

      if (typeof scene.duration !== 'number' || scene.duration <= 0) {
        errors.push(`${prefix}: "duration" must be a positive number`);
      }

      if (
        !scene.runway_parameters ||
        typeof scene.runway_parameters !== 'object' ||
        typeof scene.runway_parameters.prompt !== 'string' ||
        scene.runway_parameters.prompt.trim() === ''
      ) {
        errors.push(`${prefix}: missing or empty "runway_parameters.prompt"`);
      }
    });

    // Validate total duration matches sum of scene durations
    if (typeof json.total_duration === 'number') {
      const sumDurations = json.scenes.reduce((acc, scene) => {
        return acc + (typeof scene.duration === 'number' ? scene.duration : 0);
      }, 0);

      if (Math.abs(sumDurations - json.total_duration) > 1) {
        errors.push(
          `Total scene durations (${sumDurations}s) do not match "total_duration" (${json.total_duration}s)`
        );
      }
    } else {
      errors.push('"total_duration" must be a positive number');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parse a JSON string and validate it as a storyline.
 * Convenience wrapper that handles JSON.parse errors.
 *
 * @param {string} jsonString - Raw JSON string from Gemini output
 * @returns {{ valid: boolean, errors: string[], data: object | null }}
 */
export function parseAndValidateStoryline(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    return { valid: false, errors: [`Invalid JSON: ${err.message}`], data: null };
  }

  const result = validateStorylineJSON(parsed);
  return { ...result, data: result.valid ? parsed : null };
}
