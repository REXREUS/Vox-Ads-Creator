/**
 * Style presets for VOX-Ads Creator.
 * Each preset defines visual_seed, relighting, virtual_camera, and audio_mood
 * to guide Gemini Director and Runway Producer for consistent scene generation.
 *
 * Special preset "auto" instructs Gemini to freely determine the best parameters.
 */

/** @typedef {{ visual_seed: string, relighting: { source: string, intensity: number }, virtual_camera: { motion: string, speed: number }, audio_mood: string }} StylePreset */

/** @type {Record<string, StylePreset | { auto: true, description: string }>} */
export const STYLE_PRESETS = {
  auto: {
    auto: true,
    label: '✨ Auto',
    description: 'Gemini freely determines the best parameters based on asset and concept',
  },

  cinematic: {
    label: '🎬 Cinematic',
    description: 'Film-style, dramatic, Hollywood trailer feel. Great for premium products, perfume, cars.',
    visual_seed: 'Anamorphic lens flare, film grain, warm color grade, shallow depth of field, bokeh',
    relighting: { source: 'Golden Hour', intensity: 0.8 },
    virtual_camera: { motion: 'Slow Dolly In', speed: 3 },
    audio_mood: 'Epic orchestral, strings, cinematic, 85 BPM',
  },

  thai_comedy: {
    label: '😂 Thai Comedy',
    description: 'Thai comedy ad style — exaggerated expressions, absurd situations, bright oversaturated colors.',
    visual_seed: 'Oversaturated Thai color palette, bright flat lighting, exaggerated expressions, cartoonish energy',
    relighting: { source: 'Bright Daylight', intensity: 1.0 },
    virtual_camera: { motion: 'Static', speed: 0 },
    audio_mood: 'Upbeat Thai pop, comedic stings, playful, 128 BPM',
  },

  corporate_premium: {
    label: '💼 Corporate Premium',
    description: 'Clean, minimal, professional. Like Apple, McKinsey, or premium bank ads.',
    visual_seed: 'Clean white/grey background, sharp product detail, minimal props, premium feel',
    relighting: { source: 'Studio Softbox', intensity: 0.95 },
    virtual_camera: { motion: 'Slow Zoom Out', speed: 2 },
    audio_mood: 'Ambient corporate, piano, minimal, 95 BPM',
  },

  retro_nostalgia: {
    label: '🕹️ Retro / Nostalgia',
    description: '80s-90s aesthetic — VHS grain, neon, synthwave. Great for nostalgia or retro gaming brands.',
    visual_seed: 'VHS grain overlay, neon color palette, scanlines, chromatic aberration, 80s aesthetic',
    relighting: { source: 'Neon Lights', intensity: 0.7 },
    virtual_camera: { motion: 'Pan Right', speed: 4 },
    audio_mood: 'Synthwave, retro electronic, 110 BPM',
  },

  wedding_romantic: {
    label: '💍 Wedding / Romantic',
    description: 'Weddings, jewelry, romantic perfume. Soft, dreamy, pastel.',
    visual_seed: 'Soft focus, pastel color palette, bokeh, dreamy haze, romantic atmosphere',
    relighting: { source: 'Soft Natural Light', intensity: 0.5 },
    virtual_camera: { motion: 'Crane Up', speed: 2 },
    audio_mood: 'Romantic piano, strings, gentle, 72 BPM',
  },

  ecommerce_product: {
    label: '🛍️ E-Commerce / Product',
    description: 'Product hero shots for e-commerce. Clean background, sharp detail. Like Shopee or Amazon ads.',
    visual_seed: 'Pure white or gradient background, sharp product detail, clean shadows, studio look',
    relighting: { source: 'Studio Rim Light', intensity: 0.9 },
    virtual_camera: { motion: 'Orbit 360°', speed: 3 },
    audio_mood: 'Upbeat pop, energetic, 115 BPM',
  },

  luxury_highend: {
    label: '👑 Luxury / High-End',
    description: 'Rolex, Louis Vuitton, Chanel style. Dark moody, gold accents, slow and elegant.',
    visual_seed: 'Dark moody background, gold/bronze accents, dramatic shadows, premium texture detail',
    relighting: { source: 'Candlelight + Rim', intensity: 0.6 },
    virtual_camera: { motion: 'Ultra Slow Dolly', speed: 1 },
    audio_mood: 'Jazz, minimal, sophisticated, 68 BPM',
  },

  street_food: {
    label: '🍜 Street Food / Kuliner',
    description: 'Street food, local restaurants, UMKM culinary. Warm, authentic, appetizing.',
    visual_seed: 'Warm tungsten lighting, steam/smoke effect, vibrant food colors, authentic street atmosphere',
    relighting: { source: 'Warm Tungsten', intensity: 0.85 },
    virtual_camera: { motion: 'Handheld Shake', speed: 5 },
    audio_mood: 'Lively ethnic music, upbeat, 125 BPM',
  },

  tech_gadget: {
    label: '📱 Tech / Gadget',
    description: 'Smartphones, laptops, gadgets. Futuristic, clean, blue tones. Like Samsung or Xiaomi ads.',
    visual_seed: 'Futuristic blue/cyan tones, clean lines, tech surfaces, holographic elements',
    relighting: { source: 'Cool LED Blue', intensity: 0.75 },
    virtual_camera: { motion: 'Tracking Shot', speed: 4 },
    audio_mood: 'Electronic, modern, futuristic, 118 BPM',
  },

  nature_organic: {
    label: '🌿 Nature / Organic',
    description: 'Organic products, natural skincare, healthy food. Fresh, earthy, natural.',
    visual_seed: 'Natural daylight, earthy green/brown tones, fresh textures, outdoor atmosphere',
    relighting: { source: 'Overcast Natural', intensity: 0.65 },
    virtual_camera: { motion: 'Tilt Up', speed: 2 },
    audio_mood: 'Acoustic guitar, nature sounds, peaceful, 82 BPM',
  },

  sport_energy: {
    label: '🏋️ Sport / Energy',
    description: 'Sports, energy drinks, supplements. Dynamic, high energy, motion blur.',
    visual_seed: 'High contrast, desaturated with accent colors, motion blur, dynamic angles',
    relighting: { source: 'Harsh Directional', intensity: 1.0 },
    virtual_camera: { motion: 'Fast Tracking', speed: 9 },
    audio_mood: 'EDM, high energy, intense, 140 BPM',
  },

  family_heartwarming: {
    label: '👶 Family / Heartwarming',
    description: 'Family, insurance, baby products. Warm, genuine, emotional. Like Thai Life Insurance ads.',
    visual_seed: 'Warm golden tones, soft natural light, genuine expressions, cozy atmosphere',
    relighting: { source: 'Warm Window Light', intensity: 0.7 },
    virtual_camera: { motion: 'Slow Push In', speed: 2 },
    audio_mood: 'Gentle piano, heartwarming, emotional, 78 BPM',
  },

  festival_celebration: {
    label: '🎉 Festival / Celebration',
    description: 'Hari raya, birthdays, events. Colorful, festive, energetic.',
    visual_seed: 'Bright festive colors, bokeh lights, confetti, celebratory atmosphere',
    relighting: { source: 'Festive Warm', intensity: 0.9 },
    virtual_camera: { motion: 'Crane Sweep', speed: 5 },
    audio_mood: 'Festive music, celebratory, joyful, 130 BPM',
  },

  night_moody: {
    label: '🌙 Night / Moody',
    description: 'Nightlife, evening perfume, premium bars. Dark, atmospheric, mysterious.',
    visual_seed: 'Night atmosphere, neon reflections, wet streets, moody shadows',
    relighting: { source: 'Neon Night', intensity: 0.6 },
    virtual_camera: { motion: 'Slow Dolly', speed: 2 },
    audio_mood: 'Dark ambient, atmospheric, mysterious, 88 BPM',
  },

  lifestyle_travel: {
    label: '🏖️ Lifestyle / Travel',
    description: 'Travel, resorts, lifestyle brands. Bright, aspirational, freedom.',
    visual_seed: 'Bright natural light, vibrant colors, open spaces, aspirational lifestyle',
    relighting: { source: 'Bright Outdoor', intensity: 0.85 },
    virtual_camera: { motion: 'Aerial Drone', speed: 4 },
    audio_mood: 'Uplifting, acoustic, inspirational, 100 BPM',
  },
};

/**
 * Get a preset by key. Returns null if not found.
 * @param {string} key - Preset key (e.g. 'cinematic', 'auto')
 * @returns {StylePreset | { auto: true, label: string, description: string } | null}
 */
export function getPreset(key) {
  return STYLE_PRESETS[key] ?? null;
}

/**
 * Returns all preset keys including 'auto'.
 * @returns {string[]}
 */
export function getPresetKeys() {
  return Object.keys(STYLE_PRESETS);
}

/**
 * Returns preset choices formatted for a Discord StringSelectMenu.
 * @returns {{ label: string, value: string, description: string }[]}
 */
export function getPresetChoices() {
  return Object.entries(STYLE_PRESETS).map(([key, preset]) => ({
    label: preset.label,
    value: key,
    description: preset.description.slice(0, 100), // Discord limit: 100 chars
  }));
}
