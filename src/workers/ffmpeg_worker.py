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

def run_ffmpeg_direct(cmd: list[str]) -> None:
    """Run FFmpeg via subprocess for full filter_complex control."""
    logger.info(f"Running: ffmpeg {' '.join(cmd[:4])}...")
    result = subprocess.run(
        cmd,
        capture_output=True,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")
        logger.error(f"FFmpeg failed: {stderr[-500:]}")
        try:
            with open("/tmp/vox_ffmpeg_debug.log", "w") as f:
                f.write(stderr)
        except Exception:
            pass
        raise RuntimeError(f"FFmpeg failed with exit code {result.returncode}")


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


# ---------------------------------------------------------------------------
# Main pipeline using subprocess + filter_complex
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
      3. Concatenate clips via subprocess (clean stream mapping)
      4. Optional watermark overlay
      5. Optional background audio merge
      6. Write final .mp4

    Returns the output path.
    """
    if not clips:
        raise ValueError("No clips provided")

    output_dir = os.path.dirname(output_path)
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)

    scenes = storyline.get("scenes", [])

    # Step 1 — normalize clips using ffmpeg-python (simple operation)
    tmp_dir = tempfile.mkdtemp(prefix="vox_norm_")
    normalized: list[str] = []
    
    for idx, clip_path in enumerate(clips):
        norm_path = os.path.join(tmp_dir, f"norm_{idx}.mp4")
        
        # Probe for audio
        try:
            probe = ffmpeg.probe(clip_path)
            has_audio = any(s["codec_type"] == "audio" for s in probe.get("streams", []))
            clip_duration = float(probe.get("format", {}).get("duration", 0)) or 5.0
        except Exception:
            has_audio = False
            clip_duration = 5.0
        
        vf = f"fps={TARGET_FPS},scale={TARGET_WIDTH}:{TARGET_HEIGHT}:force_original_aspect_ratio=decrease,pad={TARGET_WIDTH}:{TARGET_HEIGHT}:(ow-iw)/2:(oh-ih)/2"
        
        if has_audio:
            # Use direct subprocess for reliability
            cmd = [
                "ffmpeg", "-y", "-nostdin",
                "-i", clip_path,
                "-vf", vf,
                "-vcodec", "libx264", "-crf", "20", "-preset", "fast",
                "-acodec", "aac", "-audio_bitrate", "128k",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                norm_path
            ]
        else:
            # No audio: synthesize silence
            cmd = [
                "ffmpeg", "-y", "-nostdin",
                "-i", clip_path,
                "-f", "lavfi", "-t", str(clip_duration), "-i", "anullsrc=r=44100:cl=stereo",
                "-vf", vf,
                "-vcodec", "libx264", "-crf", "20", "-preset", "fast",
                "-acodec", "aac", "-audio_bitrate", "128k",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                "-shortest",
                norm_path
            ]
        
        run_ffmpeg_direct(cmd)
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
                
                # Normalize narration to stereo
                narr_norm = os.path.join(tmp_dir, f"narr_norm_{idx}.mp3")
                cmd_norm = [
                    "ffmpeg", "-y", "-nostdin",
                    "-i", narr_path,
                    "-af", "aformat=channel_layouts=stereo,dynaudnorm=p=0.95:maxgain=10,apad=whole_dur=" + str(clip_duration),
                    "-t", str(clip_duration),
                    "-acodec", "libmp3lame", "-b:a", "128k",
                    narr_norm
                ]
                run_ffmpeg_direct(cmd_norm)
                
                # Merge narration with clip
                if is_video_input:
                    # Strip original audio
                    cmd_merge = [
                        "ffmpeg", "-y", "-nostdin",
                        "-i", norm_path,
                        "-i", narr_norm,
                        "-vcodec", "copy",
                        "-acodec", "aac", "-audio_bitrate", "128k",
                        "-shortest",
                        narr_out
                    ]
                else:
                    # Duck original audio to 15%
                    cmd_merge = [
                        "ffmpeg", "-y", "-nostdin",
                        "-i", norm_path,
                        "-i", narr_norm,
                        "-filter_complex", "[0:a]volume=0.15[a0];[1:a][a0]amix=inputs=2:duration=first:normalize=0[a]",
                        "-vcodec", "copy",
                        "-map", "0:v",
                        "-map", "[a]",
                        "-acodec", "aac", "-audio_bitrate", "128k",
                        "-shortest",
                        narr_out
                    ]
                run_ffmpeg_direct(cmd_merge)
                narrated.append(narr_out)
            else:
                if is_video_input:
                    silent_out = os.path.join(tmp_dir, f"silent_{idx}.mp4")
                    cmd = [
                        "ffmpeg", "-y", "-nostdin",
                        "-i", norm_path,
                        "-f", "lavfi", "-t", str(get_duration(norm_path)), "-i", "anullsrc=r=44100:cl=stereo",
                        "-vcodec", "copy",
                        "-acodec", "aac",
                        "-shortest",
                        silent_out
                    ]
                    run_ffmpeg_direct(cmd)
                    narrated.append(silent_out)
                else:
                    narrated.append(norm_path)
        normalized = narrated
        logger.info(f"Narration merged into {sum(1 for p in narration_paths if p)} clips")

    # Step 3 — concatenate clips via subprocess (RELIABLE approach)
    n = len(normalized)
    temp_concat = os.path.join(tmp_dir, "concat_temp.mp4")
    
    if n == 1:
        shutil.copy(normalized[0], temp_concat)
    else:
        # Use filter_complex for clean concatenation
        filter_complex = (
            ";".join([f"[{i}:v]" for i in range(n)]) +
            "".join([f"[{i}:a]" for i in range(n)]) +
            f"concat=n={n}:v=1:a=1[outv][outa]"
        )
        
        cmd = ["ffmpeg", "-y", "-nostdin"]
        for clip in normalized:
            cmd.extend(["-i", clip])
        cmd.extend([
            "-filter_complex", filter_complex,
            "-map", "[outv]",
            "-map", "[outa]",
            "-vcodec", "libx264", "-crf", "20", "-preset", "medium",
            "-acodec", "aac", "-audio_bitrate", "192k",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            temp_concat
        ])
        run_ffmpeg_direct(cmd)
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
            fontsize = int(32 - (char_count - 8) * (12 / 12))
        else:
            fontsize = max(14, int(20 - (char_count - 20) * 0.3))
        
        cmd = [
            "ffmpeg", "-y", "-nostdin",
            "-i", temp_concat,
            "-vf", f"drawtext=text='{safe_text}':fontfile={FONT_FILE}:fontsize={fontsize}:fontcolor=white@0.85:x='max(10,w-tw-20)':y='h-th-20':shadowcolor=black@0.7:shadowx=2:shadowy=2",
            "-c:a", "copy",
            output_path
        ]
        run_ffmpeg_direct(cmd)
        final_path = output_path
    else:
        shutil.move(temp_concat, output_path)

    # Step 5 — optional background audio merge
    if audio_path and os.path.isfile(audio_path):
        logger.info("Merging background audio...")
        video_duration = get_duration(output_path)
        
        bg_trimmed = os.path.join(tmp_dir, "bg_trimmed.mp3")
        cmd = [
            "ffmpeg", "-y", "-nostdin",
            "-i", audio_path,
            "-t", str(video_duration),
            "-af", "aformat=channel_layouts=stereo,volume=0.2",
            "-acodec", "libmp3lame", "-b:a", "192k",
            bg_trimmed
        ]
        run_ffmpeg_direct(cmd)
        
        temp_with_bg = os.path.join(tmp_dir, "with_bg.mp4")
        cmd = [
            "ffmpeg", "-y", "-nostdin",
            "-i", output_path,
            "-i", bg_trimmed,
            "-filter_complex", "[0:a][1:a]amix=inputs=2:duration=first[a]",
            "-map", "0:v",
            "-map", "[a]",
            "-c:v", "copy",
            "-acodec", "aac", "-audio_bitrate", "192k",
            temp_with_bg
        ]
        run_ffmpeg_direct(cmd)
        shutil.move(temp_with_bg, output_path)

    # Cleanup
    for p in normalized:
        if os.path.dirname(os.path.abspath(p)) == os.path.abspath(tmp_dir):
            try:
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
    """Basic self-test: verify ffmpeg-python and ffmpeg binary are available."""
    logger.info("Running self-test...")
    try:
        import ffmpeg as _ffmpeg
        logger.info("ffmpeg-python import: OK")
    except ImportError as e:
        logger.error(f"ffmpeg-python not installed: {e}")
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
        clips: list[str] = json.loads(args.clips)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid --clips JSON: {e}")
        sys.exit(1)

    try:
        storyline: dict = json.loads(args.storyline)
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
        clean = msg.replace("FFmpeg failed: ", "").strip()
        logger.error(f"Processing failed: {clean}")
        sys.exit(1)


if __name__ == "__main__":
    main()