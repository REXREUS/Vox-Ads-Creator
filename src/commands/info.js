/**
 * /info command — comprehensive guide for VOX-Ads Creator.
 *
 * Shows paginated embeds covering:
 *   - Quick start guide
 *   - All commands reference
 *   - Style presets list
 *   - Tips, limits, and FAQ
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

const BTN_PREV = 'vox_info_prev';
const BTN_NEXT = 'vox_info_next';
const BTN_PAGE = 'vox_info_page_'; // prefix + pageIndex

// ─── Page Definitions ─────────────────────────────────────────────────────────

function buildPages() {
  return [
    // Page 0 — Welcome & Quick Start
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎬 VOX-Ads Creator — Welcome')
      .setDescription(
        'Transform a single product image or video into a **professional 30-second video ad** ' +
        'powered by Gemini AI and Runway video generation.\n\n' +
        '**Your data is private** — API keys are encrypted and stored only in your Discord DM.',
      )
      .addFields(
        {
          name: '🚀 Quick Start (3 steps)',
          value:
            '**1.** `/configure` — Enter your Gemini + Runway API keys\n' +
            '**2.** `/ads` — Upload your product image/video and fill in the brief\n' +
            '**3.** Review the storyline → **Approve** → Wait for your video!',
        },
        {
          name: '🔑 Where to get API keys',
          value:
            '• **Gemini:** [aistudio.google.com](https://aistudio.google.com) → Get API Key\n' +
            '• **Runway:** [dev.runwayml.com](https://dev.runwayml.com) → API Keys',
        },
        {
          name: '⏱️ How long does it take?',
          value:
            '• Storyline generation: ~15–30 seconds\n' +
            '• Video production (6 scenes): ~3–5 minutes\n' +
            '• Total end-to-end: ~4–6 minutes',
        },
      )
      .setFooter({ text: 'Page 1/5 — Use the buttons below to navigate' }),

    // Page 1 — Commands Reference
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('📋 Commands Reference')
      .addFields(
        {
          name: '`/ads`',
          value: 'Create a video ad from a product image or video (jpg, png, gif, webp, mp4, mov, webm — max 25MB)',
        },
        {
          name: '`/configure`',
          value: 'Set up your Gemini + Runway API keys and choose your preferred AI models. Keys are encrypted and stored in your DM.',
        },
        {
          name: '`/credits`',
          value: 'View your live Runway credit balance and a history of credits used per job.',
        },
        {
          name: '`/myads`',
          value: 'Browse your video ad history with pagination.',
        },
        {
          name: '`/forget`',
          value: 'Delete all your data (API keys, history, credit logs) from the bot\'s DM storage.',
        },
        {
          name: '`/info`',
          value: 'Show this guide.',
        },
        {
          name: '🔧 Admin Commands',
          value:
            '`/setratelimit` — Set max videos per hour per user, whitelist/blacklist users\n' +
            '`/setshowcase` — Set a channel to auto-post featured ads (4+ scenes)',
        },
      )
      .setFooter({ text: 'Page 2/5' }),

    // Page 2 — /ads Workflow Detail
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎬 How /ads Works')
      .addFields(
        {
          name: '1️⃣ Upload Asset',
          value: 'Attach your product image or video to `/ads`. Supported: jpg, png, gif, webp, mp4, mov, webm (max 25MB).',
        },
        {
          name: '2️⃣ Fill Ad Details',
          value:
            '• **Ad Concept** — What message do you want to convey?\n' +
            '• **Target Audience** — Who is this ad for?\n' +
            '• **Age Range** — e.g. 18-35, all ages\n' +
            '• **Theme & Style** — e.g. `Inspirational,cinematic` or `Funny,thai_comedy`\n' +
            '• **Duration, Scenes** — e.g. `30,6` = 30 seconds, 6 scenes',
        },
        {
          name: '3️⃣ Settings Panel',
          value:
            '• **Verbose JSON** — Show the full storyline JSON after delivery\n' +
            '• **Watermark** — Add your brand name as a watermark overlay',
        },
        {
          name: '4️⃣ Review Storyline',
          value:
            '• **✅ Approve** — Start production (uses Runway credits)\n' +
            '• **🔄 Regenerate** — Get a different storyline (max 3x, free)\n' +
            '• **✏️ Edit Scene** — Modify a specific scene\'s prompt before approving',
        },
        {
          name: '5️⃣ Production',
          value:
            'Scenes are generated **sequentially** (each scene continues from the last frame of the previous) ' +
            'for visual continuity. Narration and background music are generated in parallel.',
        },
        {
          name: '6️⃣ Delivery',
          value: 'Final video is posted to the channel. A copy is saved to your DM history (viewable via `/myads`).',
        },
      )
      .setFooter({ text: 'Page 3/5' }),

    // Page 3 — Style Presets
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎨 Style Presets')
      .setDescription('Enter as `Theme,style_key` in the Theme & Style field. Example: `Inspirational,cinematic`')
      .addFields(
        {
          name: '✨ auto',
          value: 'Gemini freely picks the best style for your product',
          inline: false,
        },
        {
          name: '🎬 cinematic',
          value: 'Film-style, dramatic, Hollywood trailer. Premium products, perfume, cars.',
          inline: true,
        },
        {
          name: '😂 thai_comedy',
          value: 'Exaggerated, absurd, bright colors. Comedy ads.',
          inline: true,
        },
        {
          name: '💼 corporate_premium',
          value: 'Clean, minimal, Apple/McKinsey style.',
          inline: true,
        },
        {
          name: '🕹️ retro_nostalgia',
          value: '80s-90s VHS, neon, synthwave.',
          inline: true,
        },
        {
          name: '💍 wedding_romantic',
          value: 'Soft, dreamy, pastel. Jewelry, weddings.',
          inline: true,
        },
        {
          name: '🛍️ ecommerce_product',
          value: 'Clean studio shots. Shopee/Amazon style.',
          inline: true,
        },
        {
          name: '👑 luxury_highend',
          value: 'Dark moody, gold accents. Rolex/LV style.',
          inline: true,
        },
        {
          name: '🍜 street_food',
          value: 'Warm, authentic, appetizing. UMKM culinary.',
          inline: true,
        },
        {
          name: '📱 tech_gadget',
          value: 'Futuristic, blue tones. Samsung/Xiaomi style.',
          inline: true,
        },
        {
          name: '🌿 nature_organic',
          value: 'Fresh, earthy. Organic/skincare products.',
          inline: true,
        },
        {
          name: '🏋️ sport_energy',
          value: 'High energy, motion blur. Sports/supplements.',
          inline: true,
        },
        {
          name: '👶 family_heartwarming',
          value: 'Warm, emotional. Family/insurance/baby.',
          inline: true,
        },
        {
          name: '🎉 festival_celebration',
          value: 'Colorful, festive. Hari raya, events.',
          inline: true,
        },
        {
          name: '🌙 night_moody',
          value: 'Dark, atmospheric. Nightlife, premium bars.',
          inline: true,
        },
        {
          name: '🏖️ lifestyle_travel',
          value: 'Bright, aspirational. Travel, resorts.',
          inline: true,
        },
      )
      .setFooter({ text: 'Page 4/5' }),

    // Page 4 — Limits, Tips & FAQ
    new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('💡 Tips, Limits & FAQ')
      .addFields(
        {
          name: '📊 Limits',
          value:
            '• Max file size: **25MB**\n' +
            '• Max videos per hour: **3** (admin can change per server)\n' +
            '• Max concurrent jobs per server: **3**\n' +
            '• Max storyline regenerations: **3x** (free, before approving)\n' +
            '• Scene duration: **5s or 10s** per scene',
        },
        {
          name: '💳 Credit Costs (approximate)',
          value:
            '• `gen4.5` × 6 scenes × 5s = **360 credits** per 30s ad\n' +
            '• `gen4_turbo` × 6 scenes × 5s = **150 credits** (image input only)\n' +
            '• `seedance2` × 6 scenes × 5s = **1,080 credits** (video input)\n' +
            '• Background music: ~**2 credits**\n' +
            '• Narration TTS: ~**1 credit per 50 chars** per scene\n' +
            'Check balance anytime with `/credits`',
        },
        {
          name: '🎙️ Narration & Audio',
          value:
            '• Narration is auto-generated by Gemini AI in your input language\n' +
            '• Voice is chosen automatically based on product type (e.g. Eleanor, Vincent, Serene)\n' +
            '• Background music mood is matched to your product context\n' +
            '• For video input: original audio is replaced by narration + background music',
        },
        {
          name: '🔒 Privacy & Security',
          value:
            '• API keys are encrypted with AES-256-GCM and stored only in your Discord DM\n' +
            '• Keys are never logged or stored on any server\n' +
            '• Use `/forget` to permanently delete all your data',
        },
        {
          name: '❓ FAQ',
          value:
            '**Q: My video looks the same across all scenes?**\n' +
            'A: Each scene uses the last frame of the previous scene as input — this is by design for visual continuity. Try a more dynamic concept.\n\n' +
            '**Q: Runway returned an error?**\n' +
            'A: Check your credit balance with `/credits`. Also verify your API key in `/configure`.\n\n' +
            '**Q: Can I use the bot in DMs?**\n' +
            'A: Yes! `/ads` works in DMs — progress updates are sent directly to you.',
        },
      )
      .setFooter({ text: 'Page 5/5 — VOX-Ads Creator | Powered by Gemini AI + Runway' }),
  ];
}

// ─── Navigation Helpers ───────────────────────────────────────────────────────

function buildNavRow(currentPage, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BTN_PREV)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === 0),
    new ButtonBuilder()
      .setCustomId(`${BTN_PAGE}${currentPage}`)
      .setLabel(`${currentPage + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(BTN_NEXT)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage === totalPages - 1),
  );
}

// In-memory page state per user (cleared after 10 minutes)
const userPages = new Map();

function setUserPage(userId, page) {
  userPages.set(userId, page);
  setTimeout(() => userPages.delete(userId), 10 * 60 * 1000);
}

// ─── Command Definition ───────────────────────────────────────────────────────

export const data = new SlashCommandBuilder()
  .setName('info')
  .setDescription('How to use VOX-Ads Creator — commands, style presets, tips, and FAQ');

// ─── Slash Command Handler ────────────────────────────────────────────────────

export async function execute(interaction) {
  const pages = buildPages();
  setUserPage(interaction.user.id, 0);

  await interaction.reply({
    embeds: [pages[0]],
    components: [buildNavRow(0, pages.length)],
    ephemeral: true,
  });
}

// ─── Button Handler ───────────────────────────────────────────────────────────

export async function handleButton(interaction) {
  const { customId, user } = interaction;
  if (customId !== BTN_PREV && customId !== BTN_NEXT) return false;

  const pages = buildPages();
  const current = userPages.get(user.id) ?? 0;
  const next = customId === BTN_NEXT
    ? Math.min(current + 1, pages.length - 1)
    : Math.max(current - 1, 0);

  setUserPage(user.id, next);

  await interaction.update({
    embeds: [pages[next]],
    components: [buildNavRow(next, pages.length)],
  });

  return true;
}
