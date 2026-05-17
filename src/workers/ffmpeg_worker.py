#!/usr/bin/env python3
"""
FFmpeg post-production worker for VOX-Ads Creator.

Receives scene clips from Node.js via CLI arguments, normalizes frame rates,
adds crossfade transitions, merges audio, applies watermark, and outputs
the final .mp4 path to stdout.

Usage:
    python3 ffmpeg_worker.py \
        --clips '["scene_1.mp4","scene_2.mp4"]' \
        --storyline '{"scenes":[...]}' \
        --output /tmp/vox_jobs/{job_id}/final.mp4 \
        [--watermark "Brand Name"] \
        [--audio /tmp/vox_jobs/{job_id}/bg_music.mp3]
"""

import argparse
import json
import logging
import os
import sys
import subprocess
import tempfile
import shutil
from typing import Optional

import ffmpeg

# Logging goes to stderr so stdout stays clean for the output path
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [ffmpeg_worker] %(levelname)s %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger(__name__)

TARGET_FPS = 24
TARGET_WIDTH = 1280
TARGET_HEIGHT = 720

# DejaVu Sans is installed via fonts-dejavu-core (Dockerfile) or available in most Linux envs.
# Fallback to empty string lets FFmpeg use its built-in default font if the file is missing.
_DEJAVU_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]
_WINDOWS_FONT_PATHS = [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/calibrib.ttf",
    "C:/Windows/Fonts/verdanab.ttf",
    "C:/Windows/Fonts/verdana.ttf",
]
FONT_FILE = next(
    (p for p in _DEJAVU_PATHS + _WINDOWS_FONT_PATHS if os.path.isfile(p)),
    None,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_FFMPEG_NOISE_PREFIXES = (
    "frame=", "fps=", "size=", "time=", "bitrate=", "speed=",
    "Stream #", "  Stream #", "Input #", "Output #",
    "  Duration:", "  Chapter", "  Program", "  Metadata:",
    "    handler_name", "    vendor_id", "    encoder",
    "    major_brand", "    minor_version", "    compatible_brands",
    "    creation_time", "    language", "    title",
    "video:", "audio:", "subtitle:", "global headers",
    "muxing overhead", "ffmpeg version", "built with", "configuration:",
    "libav", "lib", "  lib",
)

def _is_ffmpeg_noise(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return True
    for prefix in _FFMPEG_NOISE_PREFIXES:
        if stripped.startswith(prefix):
            return True
    # Metadata key-value lines: "  key    : value" or "handler_name    : VideoHandler"
    # These are stream/container metadata, not errors
    if "    :" in line or (": " in line and line.startswith("  ") and not any(
        kw in line for kw in ("Error", "error", "Invalid", "failed", "Cannot", "No such")
    )):
        # Only skip if it looks like a metadata line (indented key: value)
        import re
        if re.match(r"^\s+\w[\w_\s]+\s*:\s*\S", line):
            return True
    return False

def _extract_ffmpeg_error(stderr: str) -> str:
    """Extract the meaningful error lines from FFmpeg stderr, filtering out metadata noise."""
    lines = stderr.splitlines()
    meaningful = [l for l in lines if not _is_ffmpeg_noise(l)]

    # Prefer lines that explicitly mention an error/failure
    error_lines = [
        l for l in meaningful
        if any(kw in l for kw in (
            "Error", "error", "Invalid", "invalid",
            "No such", "failed", "Failed", "Cannot", "cannot",
            "Unrecognized", "not found", "Permission denied",
            "moov atom", "codec not found", "Conversion failed",
        ))
    ]

    if error_lines:
        return "\n".join(error_lines[-5:]).strip()
    if meaningful:
        return "\n".join(meaningful[-8:]).strip()
    return stderr[-300:].strip()


def run_ffmpeg(stream) -> None:
    """Run an ffmpeg stream, capturing stderr and re-raising with detail on failure."""
    try:
        # Compile to command list, then add -nostdin to disable interactive prompts
        cmd = stream.overwrite_output().compile()
        # Insert -nostdin after 'ffmpeg' command
        if '-nostdin' not in cmd:
            cmd.insert(1, '-nostdin')
        
        subprocess.run(cmd, check=True, capture_output=True, stdin=subprocess.DEVNULL)
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else "(no stderr)"
        summary = _extract_ffmpeg_error(stderr)
        logger.error(f"FFmpeg failed: {summary}")
        try:
            with open("/tmp/vox_ffmpeg_debug.log", "w") as f:
                f.write(stderr)
            logger.error(f"Full FFmpeg stderr written to /tmp/vox_ffmpeg_debug.log")
        except Exception:
            pass
        raise RuntimeError(f"FFmpeg failed: {summary}") from e
    except ffmpeg.Error as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else "(no stderr)"
        summary = _extract_ffmpeg_error(stderr)
        logger.error(f"FFmpeg failed: {summary}")
        try:
            with open("/tmp/vox_ffmpeg_debug.log", "w") as f:
                f.write(stderr)
            logger.error(f"Full FFmpeg stderr written to /tmp/vox_ffmpeg_debug.log")
        except Exception:
            pass
        raise RuntimeError(f"FFmpeg failed: {summary}") from e


def normalize_clip(input_path: str, output_path: str) -> None:
    """Re-encode a single clip to 24 fps, 1280×720, yuv420p, stereo AAC audio."""
    logger.info(f"Normalizing {input_path} → {output_path}")

    # Probe to check if the clip has an audio stream
    try:
        probe = ffmpeg.probe(input_path)
    except ffmpeg.Error as e:
        stderr = e.stderr.decode("utf-8", errors="replace") if e.stderr else ""
        raise RuntimeError(f"Failed to probe {input_path}: {stderr[-300:]}") from e

    has_audio = any(s["codec_type"] == "audio" for s in probe.get("streams", []))
    clip_duration = float(probe.get("format", {}).get("duration", 0)) or 5.0

    vf = (
        f"fps={TARGET_FPS},scale={TARGET_WIDTH}:{TARGET_HEIGHT}:force_original_aspect_ratio=decrease,"
        f"pad={TARGET_WIDTH}:{TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2"
    )

    video_in = ffmpeg.input(input_path)

    if has_audio:
        # Force stereo — acrossfade/amix require consistent channel layout
        audio_stream = video_in.audio.filter("aformat", channel_layouts="stereo")
        out = ffmpeg.output(
            video_in.video,
            audio_stream,
            output_path,
            vf=vf,
            vcodec="libx264",
            crf=20,
            preset="fast",
            acodec="aac",
            audio_bitrate="128k",
            pix_fmt="yuv420p",
            movflags="+faststart",
        )
    else:
        # No audio stream — synthesize stereo silence so downstream filters always have audio
        silence = (
            ffmpeg.input(f"anullsrc=r=44100:cl=stereo", format="lavfi", t=clip_duration)
            .audio
            .filter("asetpts", "PTS-STARTPTS")
        )
        out = ffmpeg.output(
            video_in.video,
            silence,
            output_path,
            vf=vf,
            vcodec="libx264",
            crf=20,
            preset="fast",
            acodec="aac",
            audio_bitrate="128k",
            pix_fmt="yuv420p",
            movflags="+faststart",
        )

    run_ffmpeg(out)


def get_duration(path: str) -> float:
    """Return video duration in seconds using ffprobe."""
    try:
        probe = ffmpeg.probe(path)
    except ffmpeg.Error:
        return 5.0  # safe fallback
    video_streams = [s for s in probe["streams"] if s["codec_type"] == "video"]
    if video_streams and "duration" in video_streams[0]:
        return float(video_streams[0]["duration"])
    return float(probe["format"].get("duration", 5.0))


def _strip_audio(clip_path: str, output_path: str) -> None:
    """Replace clip audio with stereo silence — used for video input scenes without narration."""
    clip_duration = get_duration(clip_path)
    video_in = ffmpeg.input(clip_path)
    silence = (
        ffmpeg.input(f"anullsrc=r=44100:cl=stereo", format="lavfi", t=clip_duration)
        .audio
        .filter("asetpts", "PTS-STARTPTS")
    )
    run_ffmpeg(
        ffmpeg
        .output(
            video_in.video, silence, output_path,
            vcodec="libx264", crf=20, preset="fast",
            acodec="aac", audio_bitrate="128k",
            pix_fmt="yuv420p",
        )
    )


def merge_narration_into_clip(clip_path: str, narration_path: str, output_path: str, strip_original_audio: bool = False) -> None:
    """
    Merge a narration audio track into a video clip.

    strip_original_audio=True  → video input: discard original audio entirely,
                                  use narration only (avoids 3-way audio collision)
    strip_original_audio=False → image-to-video: duck original clip audio to 15%,
                                  mix with narration at full volume
    """
    logger.info(f"Merging narration into {clip_path} (strip_original={strip_original_audio})")
    clip_duration = get_duration(clip_path)

    video_in = ffmpeg.input(clip_path)
    narr_in = ffmpeg.input(narration_path)

    # Normalize narration loudness and trim/pad to clip duration
    # Force stereo FIRST before any processing — Runway TTS may output mono
    narr_audio = (
        narr_in.audio
        .filter("aformat", channel_layouts="stereo")
        .filter("dynaudnorm", p=0.95, maxgain=10)
        .filter("apad", whole_dur=clip_duration)
        .filter("atrim", duration=clip_duration)
        .filter("asetpts", "PTS-STARTPTS")
    )

    if strip_original_audio:
        # Video input: use narration only — no original audio to avoid collision
        final_audio = narr_audio.filter("aformat", channel_layouts="stereo")
    else:
        # Image-to-video: duck original clip audio, mix under narration
        # Probe first to check if clip has audio — normalized clips should always have audio (silence if none)
        try:
            probe = ffmpeg.probe(clip_path)
            has_audio = any(s["codec_type"] == "audio" for s in probe.get("streams", []))
        except Exception:
            has_audio = False
        
        if has_audio:
            clip_audio_ducked = video_in.audio.filter("aformat", channel_layouts="stereo").filter("volume", volume=0.15)
            final_audio = ffmpeg.filter(
                [narr_audio.filter("aformat", channel_layouts="stereo"), clip_audio_ducked],
                "amix",
                inputs=2,
                duration="first",
                normalize=0,
            )
        else:
            # Clip has no audio — use narration only
            final_audio = narr_audio.filter("aformat", channel_layouts="stereo")

    run_ffmpeg(
        ffmpeg
        .output(
            video_in.video,
            final_audio,
            output_path,
            vcodec="libx264",
            crf=20,
            preset="fast",
            acodec="aac",
            audio_bitrate="128k",
            pix_fmt="yuv420p",
        )
    )


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process(
    clips: list[str],
    storyline: dict,
    output_path: str,
    watermark: Optional[str] = None,
    audio_path: Optional[str] = None,
    narration_paths: Optional[list[Optional[str]]] = None,
    is_video_input: bool = False,
) -> str:
    """
    Full post-production pipeline:
      1. Normalize all clips to 24 fps / 1280×720
      2. Merge per-scene narration audio into each clip (if provided)
         - is_video_input=True:  strip original clip audio, use narration only
         - is_video_input=False: duck original clip audio to 15%, mix with narration
      3. Crossfade transitions
      4. Optional watermark overlay
      5. Optional background audio merge (looped, ducked to 20% under narration)
      6. Write final .mp4

    Returns the output path.
    """
    if not clips:
        raise ValueError("No clips provided")

    # os.path.dirname returns '' if output_path has no directory component — guard against that
    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    # Determine transition type per scene from storyline
    scenes = storyline.get("scenes", [])

    # Step 1 — normalize clips
    tmp_dir = tempfile.mkdtemp(prefix="vox_norm_")
    normalized: list[str] = []
    for idx, clip_path in enumerate(clips):
        norm_path = os.path.join(tmp_dir, f"norm_{idx}.mp4")
        normalize_clip(clip_path, norm_path)
        normalized.append(norm_path)

    logger.info(f"Normalized {len(normalized)} clips")

    # Step 2 — merge per-scene narration into each normalized clip
    if narration_paths:
        narrated: list[str] = []
        for idx, norm_path in enumerate(normalized):
            narr_path = narration_paths[idx] if idx < len(narration_paths) else None
            if narr_path and os.path.isfile(narr_path):
                narr_out = os.path.join(tmp_dir, f"narrated_{idx}.mp4")
                merge_narration_into_clip(norm_path, narr_path, narr_out, strip_original_audio=is_video_input)
                narrated.append(narr_out)
            else:
                # No narration for this scene — if video input, still strip original audio
                # to keep audio consistent across scenes (no sudden audio from one scene)
                if is_video_input:
                    silent_out = os.path.join(tmp_dir, f"silent_{idx}.mp4")
                    _strip_audio(norm_path, silent_out)
                    narrated.append(silent_out)
                else:
                    narrated.append(norm_path)
        normalized = narrated
        logger.info(f"Narration merged into {sum(1 for p in narration_paths if p)} clips")

    # Step 3 — build filter graph
    # Use crossfade for scenes that have transition_out == "crossfade" (or default)
    # For simplicity we apply crossfade between all clips; scenes with "none" get a hard cut
    # by using a very short transition (0.01s ≈ hard cut)
    transition_durations: list[float] = []
    for i in range(len(normalized) - 1):
        scene = scenes[i] if i < len(scenes) else {}
        t_out = scene.get("transition_out", "crossfade")
        transition_durations.append(0.1 if t_out == "none" else 0.5)

    # ROBUST FIX: Concatenate clips via concat filter (not aconcat), then apply transitions
    # This avoids all stream mapping issues by pre-concatenating all clips at once
    n = len(normalized)
    
    if n == 1:
        video_stream = ffmpeg.input(normalized[0]).video
        audio_stream = ffmpeg.input(normalized[0]).audio.filter("aformat", channel_layouts="stereo")
    else:
        # Step 1: Pre-concatenate ALL clips into single video+audio streams
        # Using concat filter with v=1,a=1 to merge all inputs cleanly
        all_video = []
        all_audio = []
        for clip_path in normalized:
            inp = ffmpeg.input(clip_path)
            all_video.append(inp.video)
            all_audio.append(inp.audio.filter("aformat", channel_layouts="stereo"))
        
        # Concatenate all at once - clean stream mapping
        if len(all_video) >= 2:
            # Use concat filter to merge all streams first
            concat_video = ffmpeg.filter(all_video, "concat", n=len(all_video), v=1, a=0)
            concat_audio = ffmpeg.filter(all_audio, "concat", n=len(all_audio), v=0, a=1)
            
            # Now apply xfade transitions on the concatenated video
            # Get durations after concatenation
            durations = [get_duration(p) for p in normalized]
            
            # Build xfade chain on pre-concatenated video
            offset = 0.0
            video_stream = concat_video
            
            for i in range(1, n):
                td = transition_durations[i - 1]
                max_td = min(durations[i - 1], durations[i]) / 2.0
                td = min(td, max_td) if max_td > 0 else 0.1
                td = max(td, 0.1)
                new_offset = offset + durations[i - 1] - td
                if new_offset <= offset:
                    new_offset = offset + max(durations[i - 1] - 0.1, 0.01)
                    td = 0.1
                offset = new_offset
                video_stream = ffmpeg.filter(
                    [video_stream, all_video[i]],
                    "xfade",
                    transition="fade",
                    duration=td,
                    offset=round(offset, 4),
                )
            
            audio_stream = concat_audio
        else:
            video_stream = all_video[0]
            audio_stream = all_audio[0]
        
        logger.info(f"Video+Audio concatenation complete via concat filter")
    # Step 4 — optional watermark
    if watermark:
        if not FONT_FILE:
            logger.warning("No font file found — skipping watermark overlay (font required for drawtext)")
        else:
            logger.info(f"Adding watermark: {watermark}")
            # Escape special characters for drawtext
            safe_text = watermark.replace("'", "\\'").replace(":", "\\:")

            # Dynamic font size: scale down for long text so it never overflows the video.
            # Base size 32px for short text (≤8 chars), shrinks proportionally down to min 14px.
            char_count = len(watermark)
            if char_count <= 8:
                fontsize = 32
            elif char_count <= 20:
                # Linear scale: 32px at 8 chars → 20px at 20 chars
                fontsize = int(32 - (char_count - 8) * (12 / 12))
            else:
                # Very long text: clamp to 14px minimum
                fontsize = max(14, int(20 - (char_count - 20) * 0.3))

            video_stream = video_stream.drawtext(
                text=safe_text,
                fontfile=FONT_FILE,
                fontsize=fontsize,
                fontcolor="white@0.85",
                x="max(10, w-tw-20)",
                y="h-th-20",
                shadowcolor="black@0.7",
                shadowx=2,
                shadowy=2,
            )

    # Step 5 — prepare output streams (will be rendered in 2 stages below)
    # Video stream already has watermark applied if requested
    # Audio stream already has crossfaded narration from all clips

    logger.info(f"Rendering final video → {output_path}")
    
    # Split into 2 stages for reliability:
    # Stage 1: Video stitching with crossfade (no complex audio mixing yet)
    # Stage 2: Audio mixing and final merge
    
    temp_video_path = output_path.replace('.mp4', '_temp_video.mp4')
    
    # Stage 1: Render video with simple audio (just the crossfaded narration track)
    stage1_out = ffmpeg.output(
        video_stream,
        audio_stream,
        temp_video_path,
        vcodec="libx264",
        crf=20,
        preset="medium",
        acodec="aac",
        audio_bitrate="192k",
        pix_fmt="yuv420p",
        movflags="+faststart",
    )
    
    logger.info("Stage 1: Rendering video with crossfade transitions...")
    run_ffmpeg(stage1_out)
    
    # Stage 2: If background audio exists, merge it with the video
    if audio_path and os.path.isfile(audio_path):
        logger.info("Stage 2: Merging background audio...")
        
        video_in = ffmpeg.input(temp_video_path)
        bg_in = ffmpeg.input(audio_path, stream_loop=-1)
        
        # Get video duration for audio trimming
        video_duration = get_duration(temp_video_path)
        
        # Prepare audio streams
        video_audio = video_in.audio.filter("aformat", channel_layouts="stereo")
        bg_audio_trimmed = (
            bg_in.audio
            .filter("aformat", channel_layouts="stereo")
            .filter("atrim", duration=video_duration)
            .filter("asetpts", "PTS-STARTPTS")
            .filter("volume", volume=0.2)  # Duck background to 20%
        )
        
        # Simple 2-input amix
        final_audio = ffmpeg.filter(
            [video_audio, bg_audio_trimmed],
            "amix",
            inputs=2,
            duration="first",
        )
        
        stage2_out = ffmpeg.output(
            video_in.video,
            final_audio,
            output_path,
            vcodec="copy",  # Copy video — no re-encode
            acodec="aac",
            audio_bitrate="192k",
        )
        
        run_ffmpeg(stage2_out)
        
        # Cleanup temp video
        try:
            os.remove(temp_video_path)
        except OSError:
            pass
    else:
        # No background audio — just rename temp to final
        import shutil
        shutil.move(temp_video_path, output_path)

    # Cleanup normalized temp files — only after render is complete
    # Collect all intermediate files created in tmp_dir
    for p in normalized:
        # Only delete files inside our temp dir — never delete original clips
        if os.path.dirname(os.path.abspath(p)) == os.path.abspath(tmp_dir):
            try:
                os.remove(p)
            except OSError:
                pass
    try:
        os.rmdir(tmp_dir)
    except OSError:
        pass

    return output_path


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="VOX-Ads FFmpeg post-production worker")
    parser.add_argument("--clips", required=True, help="JSON array of clip file paths")
    parser.add_argument("--storyline", required=True, help="JSON storyline object")
    parser.add_argument("--output", required=True, help="Output .mp4 file path")
    parser.add_argument("--watermark", default=None, help="Watermark text to overlay")
    parser.add_argument("--audio", default=None, help="Background audio file path")
    parser.add_argument("--narrations", default=None, help="JSON array of per-scene narration audio paths (null for scenes without narration)")
    parser.add_argument("--is_video_input", action="store_true", help="Input asset was a video — strip original clip audio to avoid collision with narration and background music")
    parser.add_argument("--test", action="store_true", help="Run self-test and exit")
    return parser.parse_args()


def self_test() -> None:
    """Basic self-test: verify ffmpeg-python and ffmpeg binary are available."""
    logger.info("Running self-test...")
    try:
        import ffmpeg as _ffmpeg
        probe = _ffmpeg.probe  # noqa: F841 — just check import
        logger.info("ffmpeg-python import: OK")
    except ImportError as e:
        logger.error(f"ffmpeg-python not installed: {e}")
        sys.exit(1)

    try:
        import subprocess
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            raise RuntimeError("ffmpeg binary returned non-zero exit code")
        first_line = result.stdout.splitlines()[0] if result.stdout else "(no output)"
        logger.info(f"ffmpeg binary: {first_line}")
    except FileNotFoundError:
        logger.error("ffmpeg binary not found in PATH")
        sys.exit(1)
    except Exception as e:
        logger.error(f"ffmpeg binary check failed: {e}")
        sys.exit(1)

    logger.info("Self-test passed")
    print("ok")


def main() -> None:
    args = parse_args()

    if args.test:
        self_test()
        return

    # Parse JSON inputs
    try:
        clips: list[str] = json.loads(args.clips)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid --clips JSON: {e}")
        sys.exit(1)

    try:
        storyline: dict = json.loads(args.storyline)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid --storyline JSON: {e}")
        sys.exit(1)

    # Validate clip paths exist
    missing = [p for p in clips if not os.path.isfile(p)]
    if missing:
        logger.error(f"Missing clip files: {missing}")
        sys.exit(1)

    try:
        output = process(
            clips=clips,
            storyline=storyline,
            output_path=args.output,
            watermark=args.watermark,
            audio_path=args.audio,
            narration_paths=json.loads(args.narrations) if args.narrations else None,
            is_video_input=args.is_video_input,
        )
        # Output final path to stdout for Node.js to read
        print(output)
    except Exception as e:
        # Print only the clean error message — no traceback, no raw FFmpeg stderr noise.
        # Node.js reads all stderr, so we must keep it clean and actionable.
        msg = str(e)
        # Strip "FFmpeg failed: " prefix if present — Node.js adds its own context
        clean = msg.replace("FFmpeg failed: ", "").strip()
        logger.error(f"Processing failed: {clean}")
        sys.exit(1)


if __name__ == "__main__":
    main()
