# Privacy Policy — VOX-Ads Creator

**Last updated:** May 7, 2026

## 1. Overview

VOX-Ads Creator ("the Bot") is designed with privacy as a core principle. We do not collect, store, sell, or share your personal data. This policy explains what minimal data the Bot handles and how.

## 2. Data We Do NOT Collect

The Bot developer does **not** collect or have access to:

- Your name, email address, or any personal identifiers.
- Your API keys (they are encrypted and stored only in your own Discord DM).
- Generated videos or images.
- Your ad concepts, prompts, or creative briefs.
- Payment information of any kind.

## 3. How the Bot Handles Data

### 3.1 API Keys (BYOK)

When you run `/configure`, your API keys are:

1. Encrypted locally using AES-256-GCM with PBKDF2 key derivation.
2. Stored **only in your own Discord DM** — a private message between you and the Bot.
3. Never transmitted to or stored on any server operated by the Bot developer.
4. Decrypted in memory only for the duration of a single API call, then discarded.

### 3.2 Temporary Files

During video generation, temporary files (video clips, audio) are created in server memory:

- Stored in an isolated temporary directory (`/tmp/vox_jobs/{job_id}/`).
- Automatically deleted immediately after the final video is delivered to you.
- Never retained, backed up, or accessible after deletion.

### 3.3 Discord Messages

The Bot sends messages to your Discord DM to store:

- Encrypted API key payload.

- Video history metadata (title, duration, style — no video files).
- Credit usage logs (approximate Runway credit counts).

This data lives in **your** Discord DM and is subject to Discord's own Privacy Policy. You can delete it at any time using the `/forget` command.

### 3.4 Discord Threads

When a job runs in a server, a Discord thread is created for progress tracking. This thread contains only status messages and is archived after the job completes.

## 4. Third-Party Services

When you use the Bot, your asset and prompt data is sent to:

| Service | Purpose | Their Privacy Policy |
|---------|---------|----------------------|
| Google Gemini | Asset analysis and storyline generation | [Google Privacy Policy](https://policies.google.com/privacy) |
| Runway ML | Video and audio generation | [Runway Privacy Policy](https://runwayml.com/privacy-policy/) |
| Discord | Bot platform and message delivery | [Discord Privacy Policy](https://discord.com/privacy) |

The Bot developer is not responsible for how these third parties handle your data. Please review their policies before use.

## 5. Data Retention

The Bot developer retains **no user data**. All data associated with your use of the Bot exists either:

- In your own Discord DM (under your control), or
- Temporarily in memory during active processing (auto-deleted after completion).

## 6. Your Rights

You have full control over your data:

- **Delete your keys and history:** Use `/forget` to remove all Bot-stored data from your Discord DM.
- **No account required:** The Bot does not create accounts or profiles.
- **No tracking:** The Bot does not use analytics, cookies, or tracking of any kind.

## 7. Children's Privacy

The Bot is not intended for users under the age of 13 (or the applicable age of digital consent in your jurisdiction). We do not knowingly collect data from minors.

## 8. Security

Your API keys are protected by:

- AES-256-GCM encryption (industry standard).
- PBKDF2 key derivation scoped to your Discord User ID.
- Storage exclusively within your own Discord DM channel.

No encryption system is 100% foolproof. Use the Bot at your own risk.

## 9. Changes to This Policy

This Privacy Policy may be updated at any time. Continued use of the Bot after changes constitutes acceptance of the updated policy.

## 10. Contact

For privacy-related questions or data deletion requests, contact the Bot developer via the official Discord server.

---

*This policy reflects the Bot's stateless, zero-storage architecture. The Bot developer genuinely cannot access your data because it is never sent to or stored by the developer.*
