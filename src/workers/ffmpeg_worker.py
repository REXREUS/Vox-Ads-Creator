#!/usr/bin/env python3
"""
FFmpeg post-production worker for VOX-Ads Creator.

Receives scene clips from Node.js via CLI arguments, normalizes frame rates,
merges audio, applies watermark, and outputs the final .mp4 path to stdout.

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
import time
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
# All normalized clips must share identical audio properties for demuxer concat to work.
AUDIO_SAMPLE_RATE = 44100
AUDIO_CHANNELS = 2  # stereo

# DejaVu Sans is installed via fonts-dejavu-core (Dockerfile) or available in most Linux envs.
_DEJAVU_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]
_WINDOWS_FONT_PATHS = [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/verdana.ttf",
]
FONT_FILE = next(
    (p for p in _DEJAVU_PATHS + _WINDOWS_FONT_PATHS if os.path.isfile(p)),
    None,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def run_ffmpeg(cmd: list[str], retries: int = 2) -> None:
    """Run FFmpeg via subprocess with retry logic."""
    last_error = None
    for attempt in range(retries + 1):
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                stdin=subprocess.DEVNULL,
                timeout=1800,  # 30 minute timeout per command
            )
            if result.returncode == 0:
                return
            last_error = result.stderr.decode("utf-8", errors="replace")
            if attempt < retries:
                logger.warning(f"FFmpeg attempt {attempt + 1} failed, retrying in 1s...")
                time.sleep(1)
        except subprocess.TimeoutExpired:
            last_error = "Command timed out after 1800 seconds"
            if attempt < retries:
                logger.warning(f"FFmpeg attempt {attempt + 1} timed out, retrying...")
        except Exception as e:
            last_error = str(e)
            if attempt < retries:
                logger.warning(f"FFmpeg attempt {attempt + 1} error: {e}, retrying...")

    # All retries failed
    stderr_summary = last_error[-500:] if last_error else "unknown error"
    logger.error(f"FFmpeg failed after {retries + 1} attempts: {stderr_summary}")
    try:
        with open("/tmp/vox_ffmpeg_debug.log", "w") as f:
            f.write(last_error or "No error message")
    except Exception:
        pass
    raise RuntimeError(f"FFmpeg failed after {retries + 1} attempts")


def get_duration(path: str) -> float:
    """Return video duration in seconds using ffprobe."""
    try:
        probe = ffmpeg.probe(path)
        video_streams = [s for s in probe["streams"] if s["codec_type"] == "video"]
        if video_streams and "duration" in video_streams[0]:
            return float(video_streams[0]["duration"])
        return float(probe["format"].get("duration", 5.0))
    except Exception as e:
        logger.warning(f"Failed to probe {path}: {e}, using fallback 5.0s")
        return 5.0


def probe_clip(clip_path: str) -> tuple[bool, float]:
    """Probe clip for audio presence and duration."""
    try:
        probe = ffmpeg.probe(clip_path)
        has_audio = any(s["codec_type"] == "audio" for s in probe.get("streams", []))
        duration = float(probe.get("format", {}).get("duration", 0)) or 5.0
        return has_audio, duration
    except Exception:
        return False, 5.0


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
      1. Normalize all clips to identical format (24fps, 1280x720, AAC 44100Hz stereo)
      2. Merge per-scene narration audio into each clip (if provided)
      3. Concatenate clips using demuxer concat (fast, stream-copy, ultra-robust)
      4. Optional watermark overlay
      5. Optional background audio merge
      6. Write final .mp4

    Uses demuxer concat (-f concat -safe 0) instead of filter_complex concat
    to avoid FFmpeg filtergraph stream parameter strictness.
    """
    if not clips:
        raise ValueError("No clips provided")

    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    # Step 1 — normalize all clips to identical codec parameters
    # This is the critical step: ALL output files must have IDENTICAL:
    # - Video: H.264, 24fps, 1280x720, yuv420p, SAR=1:1
    # - Audio: AAC, 44100Hz, stereo (2 channels)
    tmp_dir = tempfile.mkdtemp(prefix="vox_norm_")
    normalized: list[str] = []

    for idx, clip_path in enumerate(clips):
        norm_path = os.path.join(tmp_dir, f"norm_{idx}.mp4")
        has_audio, clip_duration = probe_clip(clip_path)

        # Video filter: normalize fps, scale, pad, and FORCE square pixels (SAR=1:1)
        vf = (
            f"fps={TARGET_FPS},"
            f"scale={TARGET_WIDTH}:{TARGET_HEIGHT}:force_original_aspect_ratio=decrease,"
            f"pad={TARGET_WIDTH}:{TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2,"
            f"setsar=1"
        )

        # Use CRF 28 to compress output heavily and avoid Discord's 25MB attachment limit
        # (CRF 20 often yields files > 30MB for 30 seconds of HD video)
        if has_audio:
            cmd = [
                "ffmpeg", "-y", "-nostdin",
                "-i", clip_path,
                "-vf", vf,
                "-map", "0:v:0",  # explicitly select first video stream
                "-map", "0:a:0",  # explicitly select first audio stream
                "-c:v", "libx264", "-crf", "28", "-preset", "medium",
                "-c:a", "aac", "-b:a", "128k",
                "-ar", str(AUDIO_SAMPLE_RATE), "-ac", str(AUDIO_CHANNELS),
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                norm_path
            ]
        else:
            # No audio stream: synthesize identical silence
            cmd = [
                "ffmpeg", "-y", "-nostdin",
                "-i", clip_path,
                "-f", "lavfi", "-t", str(clip_duration),
                "-i", f"anullsrc=r={AUDIO_SAMPLE_RATE}:cl=stereo",
                "-vf", vf,
                "-map", "0:v:0",
                "-map", "1:a",
                "-c:v", "libx264", "-crf", "28", "-preset", "medium",
                "-c:a", "aac", "-b:a", "128k",
                "-ar", str(AUDIO_SAMPLE_RATE), "-ac", str(AUDIO_CHANNELS),
                "-pix_fmt", "yuv420p",
                "-movflags", "+faststart",
                "-shortest",
                norm_path
            ]

        run_ffmpeg(cmd)
        normalized.append(norm_path)
        logger.info(f"Normalized clip {idx + 1}/{len(clips)}")

    logger.info(f"Normalized {len(normalized)} clips")

    # Step 2 — merge per-scene narration into each normalized clip
    if narration_paths:
        narrated: list[str] = []
        for idx, norm_path in enumerate(normalized):
            narr_path = narration_paths[idx] if idx < len(narration_paths) else None
            if narr_path and os.path.isfile(narr_path):
                narr_out = os.path.join(tmp_dir, f"narrated_{idx}.mp4")
                clip_duration = get_duration(norm_path)

                # Normalize narration audio to consistent format (m4a with AAC)
                narr_norm = os.path.join(tmp_dir, f"narr_norm_{idx}.m4a")
                cmd_norm = [
                    "ffmpeg", "-y", "-nostdin",
                    "-i", narr_path,
                    "-af", f"aformat=sample_rates={AUDIO_SAMPLE_RATE}:channel_layouts=stereo,volume=1.5",
                    "-t", str(clip_duration),
                    "-c:a", "aac", "-b:a", "128k",
                    "-ar", str(AUDIO_SAMPLE_RATE), "-ac", str(AUDIO_CHANNELS),
                    narr_norm
                ]
                run_ffmpeg(cmd_norm)

                if is_video_input:
                    # Video input: replace clip audio entirely with narration
                    cmd_merge = [
                        "ffmpeg", "-y", "-nostdin",
                        "-i", norm_path,
                        "-i", narr_norm,
                        "-map", "0:v:0",
                        "-map", "1:a:0",
                        "-c:v", "copy",
                        "-c:a", "aac", "-b:a", "128k",
                        "-ar", str(AUDIO_SAMPLE_RATE), "-ac", str(AUDIO_CHANNELS),
                        "-shortest",
                        narr_out
                    ]
                else:
                    # Image-to-video: duck original clip audio, mix with narration
                    af = (
                        f"[0:a]aformat=sample_rates={AUDIO_SAMPLE_RATE}:channel_layouts=stereo,"
                        f"volume=0.2[bg];"
                        f"[1:a]aformat=sample_rates={AUDIO_SAMPLE_RATE}:channel_layouts=stereo[narr];"
                        f"[narr][bg]amix=inputs=2:duration=first:normalize=0[mixed]"
                    )
                    cmd_merge = [
                        "ffmpeg", "-y", "-nostdin",
                        "-i", norm_path,
                        "-i", narr_norm,
                        "-filter_complex", af,
                        "-map", "0:v:0",
                        "-map", "[mixed]",
                        "-c:v", "copy",
                        "-c:a", "aac", "-b:a", "128k",
                        "-ar", str(AUDIO_SAMPLE_RATE), "-ac", str(AUDIO_CHANNELS),
                        narr_out
                    ]
                run_ffmpeg(cmd_merge)
                narrated.append(narr_out)
            else:
                if is_video_input:
                    # Video input, no narration: replace audio with silence
                    silent_out = os.path.join(tmp_dir, f"silent_{idx}.mp4")
                    sil_dur = get_duration(norm_path)
                    cmd_sil = [
                        "ffmpeg", "-y", "-nostdin",
                        "-i", norm_path,
                        "-f", "lavfi", "-t", str(sil_dur),
                        "-i", f"anullsrc=r={AUDIO_SAMPLE_RATE}:cl=stereo",
                        "-map", "0:v:0",
                        "-map", "1:a",
                        "-c:v", "copy",
                        "-c:a", "aac", "-b:a", "128k",
                        "-ar", str(AUDIO_SAMPLE_RATE), "-ac", str(AUDIO_CHANNELS),
                        "-shortest",
                        silent_out
                    ]
                    run_ffmpeg(cmd_sil)
                    narrated.append(silent_out)
                else:
                    # Image-to-video, no narration: use normalized clip as-is
                    narrated.append(norm_path)
        normalized = narrated
        logger.info(f"Narration merged into {sum(1 for p in narration_paths if p)} clips")

    # Step 3 — concatenate clips using DEMUXER CONCAT (not filter_complex!)
    # This is the most robust approach:
    # - No filtergraph strictness whatsoever
    # - Ultra-fast (stream copy, no re-encoding)
    # - Guaranteed to work as long as all clips have identical codec parameters
    #   (which we ensured in steps 1 and 2)
    n = len(normalized)
    temp_concat = os.path.join(tmp_dir, "concat_temp.mp4")

    if n == 1:
        shutil.copy(normalized[0], temp_concat)
        logger.info("Single clip, no concatenation needed")
    else:
        # Write concat demuxer list file
        concat_list_path = os.path.join(tmp_dir, "concat_list.txt")
        with open(concat_list_path, "w") as f:
            for clip in normalized:
                # FFmpeg requires escaped paths in concat list
                escaped = clip.replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")

        cmd = [
            "ffmpeg", "-y", "-nostdin",
            "-f", "concat",
            "-safe", "0",
            "-i", concat_list_path,
            "-c", "copy",  # stream copy — no re-encoding needed
            "-movflags", "+faststart",
            temp_concat
        ]
        run_ffmpeg(cmd)
        logger.info(f"Concatenated {n} clips via demuxer concat (stream copy)")

    # Step 4 — optional watermark overlay
    if watermark and FONT_FILE:
        logger.info(f"Adding watermark: {watermark}")
        safe_text = watermark.replace("'", "\\'").replace(":", "\\:")

        char_count = len(watermark)
        if char_count <= 8:
            fontsize = 32
        elif char_count <= 20:
            fontsize = int(32 - (char_count - 8))
        else:
            fontsize = max(14, int(20 - (char_count - 20) * 0.5))

        cmd = [
            "ffmpeg", "-y", "-nostdin",
            "-i", temp_concat,
            "-vf", (
                f"drawtext=text='{safe_text}'"
                f":fontfile={FONT_FILE}"
                f":fontsize={fontsize}"
                f":fontcolor=white@0.85"
                f":x='max(10,w-tw-20)'"
                f":y='h-th-20'"
                f":shadowcolor=black@0.7"
                f":shadowx=2:shadowy=2"
            ),
            "-c:v", "libx264", "-crf", "28", "-preset", "medium",
            "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            output_path
        ]
        run_ffmpeg(cmd)
        # Remove temp_concat since we wrote output_path above
        try:
            os.remove(temp_concat)
        except OSError:
            pass
    elif watermark and not FONT_FILE:
        logger.warning(f"No font file found for watermark — skipping")
        shutil.move(temp_concat, output_path)
    else:
        shutil.move(temp_concat, output_path)

    # Step 5 — optional background audio merge
    if audio_path and os.path.isfile(audio_path):
        logger.info("Merging background audio...")
        video_duration = get_duration(output_path)

        # Trim and normalize background audio
        bg_trimmed = os.path.join(tmp_dir, "bg_trimmed.m4a")
        cmd = [
            "ffmpeg", "-y", "-nostdin",
            "-i", audio_path,
            "-t", str(video_duration),
            "-af", f"aformat=sample_rates={AUDIO_SAMPLE_RATE}:channel_layouts=stereo,volume=0.3",
            "-c:a", "aac", "-b:a", "192k",
            "-ar", str(AUDIO_SAMPLE_RATE), "-ac", str(AUDIO_CHANNELS),
            bg_trimmed
        ]
        run_ffmpeg(cmd)

        temp_with_bg = os.path.join(tmp_dir, "with_bg.mp4")
        af = (
            f"[0:a]aformat=sample_rates={AUDIO_SAMPLE_RATE}:channel_layouts=stereo[a0];"
            f"[1:a]aformat=sample_rates={AUDIO_SAMPLE_RATE}:channel_layouts=stereo[a1];"
            f"[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[mixed]"
        )
        cmd = [
            "ffmpeg", "-y", "-nostdin",
            "-i", output_path,
            "-i", bg_trimmed,
            "-filter_complex", af,
            "-map", "0:v",
            "-map", "[mixed]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
            "-ar", str(AUDIO_SAMPLE_RATE), "-ac", str(AUDIO_CHANNELS),
            temp_with_bg
        ]
        run_ffmpeg(cmd)
        shutil.move(temp_with_bg, output_path)

    # Cleanup temp files
    for p in normalized:
        try:
            if os.path.dirname(os.path.abspath(p)) == os.path.abspath(tmp_dir):
                os.remove(p)
        except OSError:
            pass
    try:
        shutil.rmtree(tmp_dir)
    except OSError:
        pass

    logger.info(f"Render complete: {output_path}")
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
    parser.add_argument("--narrations", default=None, help="JSON array of per-scene narration audio paths")
    parser.add_argument("--is_video_input", action="store_true", help="Input was video")
    parser.add_argument("--test", action="store_true", help="Run self-test")
    return parser.parse_args()


def self_test() -> None:
    """Verify ffmpeg and python-ffmpeg are available."""
    logger.info("Running self-test...")
    try:
        import ffmpeg
        logger.info("python-ffmpeg import: OK")
    except ImportError as e:
        logger.error(f"python-ffmpeg not installed: {e}")
        sys.exit(1)

    try:
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

    try:
        clips = json.loads(args.clips)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid --clips JSON: {e}")
        sys.exit(1)

    try:
        storyline = json.loads(args.storyline)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid --storyline JSON: {e}")
        sys.exit(1)

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
        print(output)
    except Exception as e:
        msg = str(e)
        logger.error(f"Processing failed: {msg}")
        sys.exit(1)


if __name__ == "__main__":
    main()
