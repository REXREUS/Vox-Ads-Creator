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

# DejaVu Sans is installed via fonts-dejavu-core (Dockerfile) or available in most Linux envs.
_DEJAVU_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
]
_WINDOWS_FONT_PATHS = [
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/calibrib.ttf",
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
                timeout=1800,  # 30 minute timeout per command to avoid spurious timeouts
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
    logger.error(f"FFmpeg failed after {retries + 1} attempts: {last_error[-500:] if last_error else 'unknown error'}")
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
      1. Normalize all clips to 24 fps / 1280×720
      2. Merge per-scene narration audio into each clip (if provided)
      3. Concatenate clips
      4. Optional watermark overlay
      5. Optional background audio merge
      6. Write final .mp4
    """
    if not clips:
        raise ValueError("No clips provided")

    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    scenes = storyline.get("scenes", [])

    # Step 1 — normalize clips
    tmp_dir = tempfile.mkdtemp(prefix="vox_norm_")
    normalized: list[str] = []
    
    for idx, clip_path in enumerate(clips):
        norm_path = os.path.join(tmp_dir, f"norm_{idx}.mp4")
        has_audio, clip_duration = probe_clip(clip_path)
        
        vf = f"fps={TARGET_FPS},scale={TARGET_WIDTH}:{TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad={TARGET_WIDTH}:{TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2"
        
        if has_audio:
            cmd = [
                "ffmpeg", "-y", "-nostdin",
                "-i", clip_path,
                "-vf", vf,
                "-map", "0:v",
                "-map", "0:a",
                "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                "-c:a", "aac", "-b:a", "128k",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                norm_path
            ]
        else:
            # No audio stream: add silent audio track
            cmd = [
                "ffmpeg", "-y", "-nostdin",
                "-i", clip_path,
                "-f", "lavfi", "-t", str(clip_duration), "-i", "anullsrc=r=44100:cl=stereo",
                "-vf", vf,
                "-map", "0:v",
                "-map", "1:a",
                "-c:v", "libx264", "-crf", "20", "-preset", "fast",
                "-c:a", "aac", "-b:a", "128k",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                "-shortest",
                norm_path
            ]
        
        run_ffmpeg(cmd)
        normalized.append(norm_path)
        logger.info(f"Normalized clip {idx + 1}/{len(clips)}")

    logger.info(f"Normalized {len(normalized)} clips")

    # Step 2 — merge per-scene narration
    if narration_paths:
        narrated: list[str] = []
        for idx, norm_path in enumerate(normalized):
            narr_path = narration_paths[idx] if idx < len(narration_paths) else None
            if narr_path and os.path.isfile(narr_path):
                narr_out = os.path.join(tmp_dir, f"narrated_{idx}.mp4")
                clip_duration = get_duration(norm_path)
                
                # Normalize narration to stereo (simple approach, no dynaudnorm to avoid compatibility issues)
                narr_norm = os.path.join(tmp_dir, f"narr_norm_{idx}.m4a")
                cmd_norm = [
                    "ffmpeg", "-y", "-nostdin",
                    "-i", narr_path,
                    "-af", f"aformat=channel_layouts=stereo,volume=1.5",
                    "-t", str(clip_duration),
                    "-c:a", "aac", "-b:a", "128k",
                    "-ar", "44100",
                    narr_norm
                ]
                run_ffmpeg(cmd_norm)
                
                if is_video_input:
                    # Replace original audio with narration only (explicit map)
                    cmd_merge = [
                        "ffmpeg", "-y", "-nostdin",
                        "-i", norm_path,
                        "-i", narr_norm,
                        "-map", "0:v",
                        "-map", "1:a",
                        "-c:v", "copy",
                        "-c:a", "aac", "-b:a", "128k",
                        "-shortest",
                        narr_out
                    ]
                else:
                    # Mix narration with original audio (duck original)
                    cmd_merge = [
                        "ffmpeg", "-y", "-nostdin",
                        "-i", norm_path,
                        "-i", narr_norm,
                        "-filter_complex", "[0:a]volume=0.2[bg];[1:a][bg]amix=inputs=2:duration=first:normalize=0[mixed]",
                        "-map", "0:v",
                        "-map", "[mixed]",
                        "-c:v", "copy",
                        "-c:a", "aac", "-b:a", "128k",
                        narr_out
                    ]
                run_ffmpeg(cmd_merge)
                narrated.append(narr_out)
            else:
                if is_video_input:
                    # No narration for this scene but video input: replace audio with silence
                    silent_out = os.path.join(tmp_dir, f"silent_{idx}.mp4")
                    sil_dur = get_duration(norm_path)
                    cmd_sil = [
                        "ffmpeg", "-y", "-nostdin",
                        "-i", norm_path,
                        "-f", "lavfi", "-t", str(sil_dur), "-i", "anullsrc=r=44100:cl=stereo",
                        "-map", "0:v",
                        "-map", "1:a",
                        "-c:v", "copy",
                        "-c:a", "aac", "-b:a", "128k",
                        "-shortest",
                        silent_out
                    ]
                    run_ffmpeg(cmd_sil)
                    narrated.append(silent_out)
                else:
                    narrated.append(norm_path)
        normalized = narrated
        logger.info(f"Narration merged into {sum(1 for p in narration_paths if p)} clips")

    # Step 3 — concatenate clips
    n = len(normalized)
    temp_concat = os.path.join(tmp_dir, "concat_temp.mp4")
    
    if n == 1:
        shutil.copy(normalized[0], temp_concat)
        logger.info("Single clip, no concatenation needed")
    else:
        # Build filter_complex for concatenation
        # IMPORTANT: concat filter requires INTERLEAVED order: [v0][a0][v1][a1]...[vN][aN]
        # NOT grouped: [v0][v1]...[a0][a1]...
        filter_complex = (
            "".join([f"[{i}:v][{i}:a]" for i in range(n)]) +
            f"concat=n={n}:v=1:a=1[outv][outa]"
        )
        
        cmd = ["ffmpeg", "-y", "-nostdin"]
        for clip in normalized:
            cmd.extend(["-i", clip])
        cmd.extend([
            "-filter_complex", filter_complex,
            "-map", "[outv]",
            "-map", "[outa]",
            "-c:v", "libx264", "-crf", "20", "-preset", "medium",
            "-c:a", "aac", "-b:a", "192k",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            temp_concat
        ])
        run_ffmpeg(cmd)
        logger.info(f"Concatenated {n} clips into single stream")

    # Step 4 — optional watermark
    final_path = temp_concat
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
            "-vf", f"drawtext=text='{safe_text}':fontfile={FONT_FILE}:fontsize={fontsize}:fontcolor=white@0.85:x='max(10,w-tw-20)':y='h-th-20':shadowcolor=black@0.7:shadowx=2:shadowy=2",
            "-c:a", "copy",
            output_path
        ]
        run_ffmpeg(cmd)
        final_path = output_path
    elif watermark and not FONT_FILE:
        logger.warning(f"No font file found for watermark '{watermark}', skipping")
        shutil.move(temp_concat, output_path)
        final_path = output_path
    else:
        shutil.move(temp_concat, output_path)
        final_path = output_path

    # Step 5 — optional background audio merge
    if audio_path and os.path.isfile(audio_path):
        logger.info("Merging background audio...")
        video_duration = get_duration(output_path)
        
        bg_trimmed = os.path.join(tmp_dir, "bg_trimmed.m4a")
        cmd = [
            "ffmpeg", "-y", "-nostdin",
            "-i", audio_path,
            "-t", str(video_duration),
            "-af", "aformat=channel_layouts=stereo,volume=0.3",
            "-c:a", "aac", "-b:a", "192k",
            "-ar", "44100",
            bg_trimmed
        ]
        run_ffmpeg(cmd)
        
        temp_with_bg = os.path.join(tmp_dir, "with_bg.mp4")
        cmd = [
            "ffmpeg", "-y", "-nostdin",
            "-i", output_path,
            "-i", bg_trimmed,
            "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[mixed]",
            "-map", "0:v",
            "-map", "[mixed]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "192k",
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
        
        # Check for required codecs
        result = subprocess.run(
            ["ffmpeg", "-formats"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if "EAAC" in result.stdout or "aac" in result.stdout.lower():
            logger.info("AAC codec: available")
        else:
            logger.warning("AAC codec may not be fully available")
            
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