# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import ast
import contextlib
import json
import logging
import math
import os
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
from dataclasses import dataclass
from fractions import Fraction
from typing import Optional

import av
from app_conf import FFMPEG_NUM_THREADS
from dataclasses_json import dataclass_json

TRANSCODE_VERSION = 1
logger = logging.getLogger(__name__)
METADATA_PROBE_TIMEOUT_SEC = int(os.getenv("METADATA_PROBE_TIMEOUT_SEC", "20"))
FFMPEG_TRANSCODE_TIMEOUT_SEC = int(os.getenv("FFMPEG_TRANSCODE_TIMEOUT_SEC", "600"))
SHORT_VIDEO_DURATION_SECONDS = 60.0
MEDIUM_VIDEO_DURATION_SECONDS = 180.0
DEFAULT_VIDEO_TRANSCODE_GPU_INDEX = "3"
RAW_HEVC_DEFAULT_FPS = float(os.getenv("RAW_HEVC_DEFAULT_FPS", "20"))


@dataclass(frozen=True)
class TranscodeProfile:
    max_width: int
    max_height: int
    fps: int


def _parse_rotation_deg(value: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _get_video_rotation_deg(video_stream) -> float:
    try:
        side_data = getattr(video_stream, "side_data", None)
    except AttributeError:
        side_data = None

    if side_data is not None:
        try:
            return _parse_rotation_deg(side_data.get("DISPLAYMATRIX", 0))
        except AttributeError:
            pass

    metadata = getattr(video_stream, "metadata", {}) or {}
    for key in ("rotate", "rotation"):
        if key in metadata:
            return _parse_rotation_deg(metadata.get(key))
    return 0.0

def _parse_positive_int(value: object) -> int:
    try:
        parsed_value = int(value)
    except (TypeError, ValueError):
        return 0
    return parsed_value if parsed_value > 0 else 0


def _parse_fps(value: object) -> Optional[float]:
    if value in (None, "", "0/0"):
        return None
    try:
        fps = float(Fraction(str(value)))
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    if not math.isfinite(fps) or fps <= 0:
        return None
    return fps


def _safe_stream_time(value: object, time_base: object) -> float:
    if value is None or time_base is None:
        return 0.0
    try:
        return float(value * time_base)
    except (TypeError, ValueError):
        return 0.0


def _is_raw_hevc_format(format_name: Optional[str]) -> bool:
    return any(
        name.strip().lower() == "hevc"
        for name in (format_name or "").split(",")
    )


def is_raw_hevc_metadata(video_metadata: "VideoMetadata") -> bool:
    return _is_raw_hevc_format(video_metadata.format_name)


def _get_raw_hevc_packet_metadata(path: str) -> tuple[int, Optional[float]]:
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        logger.warning("ffprobe is not available; using default raw HEVC fps")
        return 0, RAW_HEVC_DEFAULT_FPS

    cmd = [
        ffprobe, "-hide_banner", "-v", "error", "-count_packets",
        "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_packets,avg_frame_rate,r_frame_rate",
        "-of", "json", path,
    ]
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=METADATA_PROBE_TIMEOUT_SEC,
        check=False,
    )
    if result.returncode != 0:
        logger.warning(
            "ffprobe raw HEVC packet count failed for %s: %s",
            path,
            (result.stderr or "").strip(),
        )
        return 0, RAW_HEVC_DEFAULT_FPS

    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError:
        logger.warning("ffprobe returned invalid JSON for raw HEVC metadata: %s", path)
        return 0, RAW_HEVC_DEFAULT_FPS

    streams = payload.get("streams") or []
    stream = streams[0] if len(streams) > 0 else {}
    packet_count = _parse_positive_int(stream.get("nb_read_packets"))
    fps = (
        _parse_fps(stream.get("avg_frame_rate"))
        or _parse_fps(stream.get("r_frame_rate"))
        or RAW_HEVC_DEFAULT_FPS
    )
    return packet_count, fps


@dataclass_json
@dataclass
class VideoMetadata:
    duration_sec: Optional[float]
    video_duration_sec: Optional[float]
    container_duration_sec: Optional[float]
    fps: Optional[float]
    width: Optional[int]
    height: Optional[int]
    num_video_frames: int
    num_video_streams: int
    video_start_time: float
    format_name: Optional[str] = None
    format_long_name: Optional[str] = None


def get_duration_adaptive_transcode_profile(
    duration_time_sec: float,
) -> TranscodeProfile:
    if duration_time_sec <= SHORT_VIDEO_DURATION_SECONDS:
        return TranscodeProfile(max_width=1280, max_height=720, fps=24)
    if duration_time_sec <= MEDIUM_VIDEO_DURATION_SECONDS:
        return TranscodeProfile(max_width=960, max_height=540, fps=12)
    return TranscodeProfile(max_width=640, max_height=360, fps=6)


def _fit_dimensions(width: int, height: int, max_width: int, max_height: int) -> tuple[int, int]:
    if max_width <= 0 or max_height <= 0:
        raise ValueError('max_width and max_height must be greater than zero')

    scale = min(max_width / width, max_height / height, 1.0)
    fitted_width = max(2, int(width * scale))
    fitted_height = max(2, int(height * scale))

    if fitted_width % 2 != 0:
        fitted_width += 1
    if fitted_height % 2 != 0:
        fitted_height += 1

    return fitted_width, fitted_height


def _normalize_transcode_backend(value: str) -> str:
    backend = value.strip().lower()
    if backend in {"cpu", "gpu"}:
        return backend

    logger.warning("invalid VIDEO_TRANSCODE_BACKEND=%r; using cpu", value)
    return "cpu"


def _is_gpu_index_available(gpu_index: str) -> bool:
    try:
        requested_index = int(gpu_index)
    except ValueError:
        logger.warning("invalid VIDEO_TRANSCODE_GPU_INDEX=%r; using cpu", gpu_index)
        return False

    if requested_index < 0:
        logger.warning("negative VIDEO_TRANSCODE_GPU_INDEX=%r; using cpu", gpu_index)
        return False

    result = subprocess.run(
        [
            "nvidia-smi",
            "--query-gpu=index",
            "--format=csv,noheader,nounits",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        logger.warning("nvidia-smi failed; using cpu transcode: %s", result.stderr)
        return False

    available_indexes = {
        int(line.strip())
        for line in result.stdout.splitlines()
        if line.strip().isdigit()
    }
    if requested_index not in available_indexes:
        logger.warning(
            "VIDEO_TRANSCODE_GPU_INDEX=%s is not available in %s; using cpu",
            requested_index,
            sorted(available_indexes),
        )
        return False

    return True


def transcode(
    in_path: str,
    out_path: str,
    in_metadata: Optional[VideoMetadata],
    seek_t: float,
    duration_time_sec: float,
):
    codec = os.environ.get("VIDEO_ENCODE_CODEC", "libx264")
    crf = int(os.environ.get("VIDEO_ENCODE_CRF", "23"))
    verbose = ast.literal_eval(os.environ.get("VIDEO_ENCODE_VERBOSE", "False"))
    backend = _normalize_transcode_backend(
        os.environ.get("VIDEO_TRANSCODE_BACKEND", "cpu")
    )
    gpu_index = os.environ.get(
        "VIDEO_TRANSCODE_GPU_INDEX",
        DEFAULT_VIDEO_TRANSCODE_GPU_INDEX,
    )
    profile = get_duration_adaptive_transcode_profile(duration_time_sec)

    normalize_video(
        in_path=in_path,
        out_path=out_path,
        max_w=profile.max_width,
        max_h=profile.max_height,
        seek_t=seek_t,
        max_time=duration_time_sec,
        in_metadata=in_metadata,
        codec=codec,
        crf=crf,
        fps=profile.fps,
        backend=backend,
        gpu_index=gpu_index,
        verbose=verbose,
    )


def get_video_metadata(path: str) -> VideoMetadata:
    def _probe() -> VideoMetadata:
        with av.open(path) as cont:
            format_name = getattr(cont.format, "name", None)
            format_long_name = getattr(cont.format, "long_name", None)
            num_video_streams = len(cont.streams.video)
            width, height, fps = None, None, None
            video_duration_sec = 0.0
            container_duration_sec = float((cont.duration or 0) / av.time_base)
            video_start_time = 0.0
            rotation_deg = 0
            num_video_frames = 0
            if num_video_streams > 0:
                video_stream = cont.streams.video[0]

                # PyAV 17 may not expose stream side_data, so read rotation defensively.
                rotation_deg = _get_video_rotation_deg(video_stream)
                num_video_frames = _parse_positive_int(video_stream.frames)
                video_start_time = _safe_stream_time(
                    getattr(video_stream, "start_time", None),
                    getattr(video_stream, "time_base", None),
                )
                width, height = video_stream.width, video_stream.height
                fps = _parse_fps(getattr(video_stream, "guessed_rate", None))
                fps_avg = _parse_fps(getattr(video_stream, "average_rate", None))
                if video_stream.duration is not None:
                    video_duration_sec = _safe_stream_time(
                        video_stream.duration,
                        getattr(video_stream, "time_base", None),
                    )
                if fps is None:
                    fps = fps_avg

                if _is_raw_hevc_format(format_name):
                    raw_packet_count, raw_fps = _get_raw_hevc_packet_metadata(path)
                    if raw_packet_count > 0:
                        num_video_frames = raw_packet_count
                    if raw_fps is not None:
                        fps = raw_fps
                    if video_duration_sec <= 0 and num_video_frames > 0 and fps:
                        video_duration_sec = num_video_frames / fps

                if not math.isnan(rotation_deg) and int(rotation_deg) in (
                    90, -90, 270, -270,
                ):
                    width, height = height, width

            duration_sec = max(container_duration_sec, video_duration_sec)

            return VideoMetadata(
                duration_sec=duration_sec,
                container_duration_sec=container_duration_sec,
                video_duration_sec=video_duration_sec,
                video_start_time=video_start_time,
                fps=fps,
                width=width,
                height=height,
                num_video_streams=num_video_streams,
                num_video_frames=num_video_frames,
                format_name=format_name,
                format_long_name=format_long_name,
            )

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_probe)
        try:
            return future.result(timeout=METADATA_PROBE_TIMEOUT_SEC)
        except FuturesTimeoutError:
            raise Exception(
                f"Timed out after {METADATA_PROBE_TIMEOUT_SEC}s reading video metadata. "
                f"The file may be corrupt, too large, or on a slow filesystem: {path}"
            )


def _build_cpu_raw_hevc_canonicalize_command(
    *,
    ffmpeg: str,
    in_path: str,
    out_path: str,
    fps: float,
) -> list[str]:
    return [
        ffmpeg,
        "-threads", f"{FFMPEG_NUM_THREADS}",
        "-f", "hevc",
        "-r", f"{fps:.6f}",
        "-i", in_path,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-threads", f"{FFMPEG_NUM_THREADS}",
        out_path,
        "-y",
    ]


def _build_gpu_raw_hevc_canonicalize_command(
    *,
    ffmpeg: str,
    in_path: str,
    out_path: str,
    fps: float,
    gpu_index: str,
) -> list[str]:
    return [
        ffmpeg,
        "-threads", f"{FFMPEG_NUM_THREADS}",
        "-f", "hevc",
        "-r", f"{fps:.6f}",
        "-i", in_path,
        "-c:v", "h264_nvenc",
        "-gpu", gpu_index,
        "-preset", "p4",
        "-rc", "vbr",
        "-cq", "23",
        "-b:v", "0",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        out_path,
        "-y",
    ]


def canonicalize_raw_hevc(
    in_path: str,
    out_path: str,
    in_metadata: VideoMetadata,
    *,
    verbose: bool = False,
) -> None:
    fps = in_metadata.fps or RAW_HEVC_DEFAULT_FPS
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg is not available on the server")

    backend = _normalize_transcode_backend(os.getenv("VIDEO_TRANSCODE_BACKEND", "cpu"))
    gpu_index = os.getenv("VIDEO_TRANSCODE_GPU_INDEX", DEFAULT_VIDEO_TRANSCODE_GPU_INDEX)
    if backend == "gpu" and _is_gpu_index_available(gpu_index):
        gpu_cmd = _build_gpu_raw_hevc_canonicalize_command(
            ffmpeg=ffmpeg,
            in_path=in_path,
            out_path=out_path,
            fps=fps,
            gpu_index=gpu_index,
        )
        try:
            logger.info(
                "canonicalizing raw HEVC with gpu backend gpu_index=%s fps=%s",
                gpu_index,
                fps,
            )
            _run_ffmpeg(gpu_cmd, verbose=verbose)
            return
        except Exception:
            logger.exception("gpu raw HEVC canonicalization failed; falling back to cpu")
            with contextlib.suppress(FileNotFoundError):
                os.remove(out_path)

    cpu_cmd = _build_cpu_raw_hevc_canonicalize_command(
        ffmpeg=ffmpeg,
        in_path=in_path,
        out_path=out_path,
        fps=fps,
    )
    logger.info("canonicalizing raw HEVC with cpu backend fps=%s", fps)
    _run_ffmpeg(cpu_cmd, verbose=verbose)


def normalize_video(
    in_path: str,
    out_path: str,
    max_w: int,
    max_h: int,
    seek_t: float,
    max_time: float,
    in_metadata: Optional[VideoMetadata],
    codec: str = "libx264",
    crf: int = 23,
    fps: int = 24,
    backend: str = "cpu",
    gpu_index: str = DEFAULT_VIDEO_TRANSCODE_GPU_INDEX,
    verbose: bool = False,
):
    if in_metadata is None:
        in_metadata = get_video_metadata(in_path)

    assert in_metadata.num_video_streams > 0, "no video stream present"

    w, h = in_metadata.width, in_metadata.height
    assert w is not None, "width not available"
    assert h is not None, "height not available"

    w, h = _fit_dimensions(w, h, max_w, max_h)

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("ffmpeg is not available on the server")

    cpu_cmd = _build_cpu_normalize_command(
        ffmpeg=ffmpeg,
        in_path=in_path,
        out_path=out_path,
        w=w,
        h=h,
        seek_t=seek_t,
        max_time=max_time,
        fps=fps,
        codec=codec,
        crf=crf,
    )

    if backend == "gpu" and _is_gpu_index_available(gpu_index):
        gpu_cmd = _build_gpu_normalize_command(
            ffmpeg=ffmpeg,
            in_path=in_path,
            out_path=out_path,
            w=w,
            h=h,
            seek_t=seek_t,
            max_time=max_time,
            fps=fps,
            crf=crf,
            gpu_index=gpu_index,
        )
        try:
            logger.info(
                "transcoding video with gpu backend gpu_index=%s size=%sx%s fps=%s",
                gpu_index,
                w,
                h,
                fps,
            )
            _run_ffmpeg(gpu_cmd, verbose=verbose)
            return
        except Exception:
            logger.exception("gpu video transcode failed; falling back to cpu")
            with contextlib.suppress(FileNotFoundError):
                os.remove(out_path)

    logger.info("transcoding video with cpu backend size=%sx%s fps=%s", w, h, fps)
    _run_ffmpeg(cpu_cmd, verbose=verbose)


def _build_cpu_normalize_command(
    *,
    ffmpeg: str,
    in_path: str,
    out_path: str,
    w: int,
    h: int,
    seek_t: float,
    max_time: float,
    fps: int,
    codec: str,
    crf: int,
) -> list[str]:
    return [
        ffmpeg,
        "-threads",
        f"{FFMPEG_NUM_THREADS}",  # global threads
        "-ss",
        f"{seek_t:.2f}",
        "-t",
        f"{max_time:.2f}",
        "-i",
        in_path,
        "-threads",
        f"{FFMPEG_NUM_THREADS}",  # decode (or filter..?) threads
        "-vf",
        f"fps={fps},scale={w}:{h},setsar=1:1",
        "-c:v",
        codec,
        "-crf",
        f"{crf}",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        f"{FFMPEG_NUM_THREADS}",  # encode threads
        out_path,
        "-y",
    ]


def _build_gpu_normalize_command(
    *,
    ffmpeg: str,
    in_path: str,
    out_path: str,
    w: int,
    h: int,
    seek_t: float,
    max_time: float,
    fps: int,
    crf: int,
    gpu_index: str,
) -> list[str]:
    return [
        ffmpeg,
        "-hwaccel",
        "cuda",
        "-hwaccel_device",
        gpu_index,
        "-hwaccel_output_format",
        "cuda",
        "-ss",
        f"{seek_t:.2f}",
        "-t",
        f"{max_time:.2f}",
        "-i",
        in_path,
        "-vf",
        f"scale_cuda={w}:{h},hwdownload,format=nv12,fps={fps},setsar=1:1",
        "-c:v",
        "h264_nvenc",
        "-gpu",
        gpu_index,
        "-preset",
        "p4",
        "-rc",
        "vbr",
        "-cq",
        f"{crf}",
        "-b:v",
        "0",
        "-pix_fmt",
        "yuv420p",
        out_path,
        "-y",
    ]


def _run_ffmpeg(cmd: list[str], *, verbose: bool) -> None:
    if verbose:
        print(" ".join(cmd))

    result = subprocess.run(
        cmd,
        stdout=None if verbose else subprocess.DEVNULL,
        stderr=None if verbose else subprocess.PIPE,
        text=True,
        timeout=FFMPEG_TRANSCODE_TIMEOUT_SEC,
    )
    if result.returncode == 0:
        return

    stderr = (result.stderr or "").strip()
    if len(stderr) > 2000:
        stderr = stderr[-2000:]
    raise RuntimeError(
        f"ffmpeg failed with exit code {result.returncode}: {stderr}"
    )
