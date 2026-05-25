# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import io
import json
import logging
import math
import mimetypes
import os
import shutil
import subprocess
import threading
import time
import uuid
import zipfile
from pathlib import Path
from typing import Dict, Optional, Sequence

import numpy as np
from app_conf import (
    DATA_PATH,
    GALLERY_PREFIX,
    MAX_UPLOAD_FILE_SIZE_BYTES,
    MAX_UPLOAD_VIDEO_DURATION,
    SERVER_VIDEO_BROWSER_ROOT,
    UPLOADS_PREFIX,
    UPLOAD_CHUNK_SIZE_BYTES,
    UPLOAD_SESSIONS_PATH,
)
from data.data_types import resolve_api_url
from data.transcoder import get_video_metadata
from data.video_processing import (
    build_uploaded_video,
    inspect_video_path,
    prepare_video_source,
    process_video_path,
    serialize_video,
)
from PIL import Image
from pycocotools.mask import decode as decode_masks

logger = logging.getLogger(__name__)

MANIFEST_FILENAME = "manifest.json"
SERVER_VIDEO_EXTENSIONS = {
    ".avi",
    ".dat",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".webm",
}
ANNOTATION_EXPORT_DIRNAME_PREFIX = "sam2_export"
ANNOTATION_EXPORT_IMAGES_DIRNAME = "images"
ANNOTATION_EXPORT_ANNOTATIONS_DIRNAME = "annotations"
ANNOTATION_EXPORT_MASKED_IMAGES_DIRNAME = "masked_images"
ANNOTATION_EXPORT_FRAME_DIGITS = 6
ANNOTATION_EXPORT_FFMPEG_BATCH_SIZE = int(
    os.getenv("ANNOTATION_EXPORT_FFMPEG_BATCH_SIZE", "250")
)
ANNOTATION_EXPORT_JPEG_QUALITY = 2
ANNOTATION_EXPORT_MASK_ALPHA = 96
ANNOTATION_EXPORT_MASKED_IMAGE_JPEG_QUALITY = 95
ANNOTATION_EXPORT_MASK_COLORS = (
    (110, 231, 249),
    (251, 115, 165),
    (250, 204, 21),
    (74, 222, 128),
    (167, 139, 250),
    (251, 146, 60),
    (96, 165, 250),
    (244, 114, 182),
)
ANNOTATION_EXPORT_STORED_ARCHIVE_SUFFIXES = {".jpg", ".jpeg"}

_UPLOAD_LOCKS: Dict[str, threading.Lock] = {}
_UPLOAD_LOCKS_GUARD = threading.Lock()


class UploadError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


class UploadNotFoundError(UploadError):
    def __init__(self, message: str = "Upload session not found"):
        super().__init__(message, status_code=404)


class UploadConflictError(UploadError):
    def __init__(self, message: str):
        super().__init__(message, status_code=409)


def _get_upload_lock(upload_id: str) -> threading.Lock:
    with _UPLOAD_LOCKS_GUARD:
        if upload_id not in _UPLOAD_LOCKS:
            _UPLOAD_LOCKS[upload_id] = threading.Lock()
        return _UPLOAD_LOCKS[upload_id]


def _drop_upload_lock(upload_id: str) -> None:
    with _UPLOAD_LOCKS_GUARD:
        _UPLOAD_LOCKS.pop(upload_id, None)


def _get_upload_dir(upload_id: str) -> Path:
    return UPLOAD_SESSIONS_PATH / upload_id


def _get_manifest_path(upload_id: str) -> Path:
    return _get_upload_dir(upload_id) / MANIFEST_FILENAME


def _get_part_path(upload_id: str, index: int) -> Path:
    return _get_upload_dir(upload_id) / f"part-{index:08d}"


def _max_upload_file_size_mb() -> int:
    return max(1, math.floor(MAX_UPLOAD_FILE_SIZE_BYTES / (1024 * 1024)))


def _validate_upload_file_size(size_bytes: int) -> None:
    if size_bytes > MAX_UPLOAD_FILE_SIZE_BYTES:
        raise UploadError(
            f"File too large. Try a video under {_max_upload_file_size_mb()} MB."
        )


def _expected_chunk_count(total_bytes: int, chunk_size_bytes: int) -> int:
    return max(1, math.ceil(total_bytes / chunk_size_bytes))


def _is_within_root(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _resolve_server_path(
    path_value: Optional[str],
    *,
    require_dir: bool = False,
    require_file: bool = False,
) -> Path:
    raw_path = str(path_value or SERVER_VIDEO_BROWSER_ROOT).strip()
    if raw_path == "":
        raise UploadError("path is required")

    candidate_path = Path(raw_path).expanduser()
    if not candidate_path.is_absolute():
        raise UploadError(f"path must be absolute: {candidate_path}")

    try:
        resolved_path = candidate_path.resolve(strict=True)
    except FileNotFoundError as error:
        raise UploadError(f"path not found: {candidate_path}", 404) from error
    except PermissionError as error:
        raise UploadError(f"path is not accessible: {candidate_path}", 403) from error
    except OSError as error:
        raise UploadError(f"path could not be resolved: {candidate_path}") from error

    if not _is_within_root(resolved_path, SERVER_VIDEO_BROWSER_ROOT):
        raise UploadError(
            f"path is outside the allowed root: {resolved_path}",
            403,
        )

    if require_dir and not resolved_path.is_dir():
        raise UploadError(f"path is not a directory: {resolved_path}")

    if require_file and not resolved_path.is_file():
        raise UploadError(f"path is not a file: {resolved_path}")

    if require_dir and not os.access(resolved_path, os.R_OK | os.X_OK):
        raise UploadError(f"path is not accessible: {resolved_path}", 403)

    if require_file and not os.access(resolved_path, os.R_OK):
        raise UploadError(f"path is not readable: {resolved_path}", 403)

    return resolved_path


def _is_supported_server_video(path: Path) -> bool:
    return path.suffix.lower() in SERVER_VIDEO_EXTENSIONS


def _build_preview_video(upload_id: str, width: int, height: int) -> dict:
    return {
        "url": resolve_api_url(f"api/uploads/{upload_id}/source"),
        "width": width,
        "height": height,
        "posterPath": None,
        "posterUrl": None,
    }




def _resolve_manifest_source_path(path_value: Optional[str]) -> Path:
    raw_path = str(path_value or "").strip()
    if raw_path == "":
        raise UploadNotFoundError("Upload source not found")

    candidate_path = Path(raw_path).expanduser()
    if not candidate_path.is_absolute():
        raise UploadError(f"source path must be absolute: {candidate_path}")

    try:
        resolved_path = candidate_path.resolve(strict=True)
    except FileNotFoundError as error:
        raise UploadNotFoundError("Upload source not found") from error
    except PermissionError as error:
        raise UploadError(f"source path is not accessible: {candidate_path}", 403) from error
    except OSError as error:
        raise UploadError(f"source path could not be resolved: {candidate_path}") from error

    allowed_roots = (SERVER_VIDEO_BROWSER_ROOT.resolve(), UPLOAD_SESSIONS_PATH.resolve())
    if not any(_is_within_root(resolved_path, root) for root in allowed_roots):
        raise UploadError(f"source path is outside the allowed roots: {resolved_path}", 403)
    if not resolved_path.is_file():
        raise UploadError(f"source path is not a file: {resolved_path}")
    if not os.access(resolved_path, os.R_OK):
        raise UploadError(f"source path is not readable: {resolved_path}", 403)
    return resolved_path


def _merge_uploaded_chunks(upload_id: str, manifest: dict, merged_path: Path) -> None:
    with open(merged_path, "wb") as merged_f:
        for index in range(manifest["totalChunks"]):
            part_path = _get_part_path(upload_id, index)
            if not part_path.exists():
                raise UploadError(f"missing chunk {index}")
            with open(part_path, "rb") as part_f:
                shutil.copyfileobj(part_f, merged_f)


def _prepare_uploaded_source(upload_id: str) -> dict:
    with _get_upload_lock(upload_id):
        manifest = _read_manifest(upload_id)
        if manifest.get("sourcePath"):
            return _serialize_manifest(manifest)
        if manifest["uploadedBytes"] != manifest["totalBytes"]:
            raise UploadError("Upload is incomplete")
        if manifest["nextChunkIndex"] != manifest["totalChunks"]:
            raise UploadError("Missing uploaded chunks")

        upload_dir = _get_upload_dir(upload_id)
        input_suffix = Path(manifest["filename"]).suffix or ".bin"
        merged_path = upload_dir / f"merged-input{input_suffix}"
        manifest_snapshot = dict(manifest)

    canonical_path = _get_upload_dir(upload_id) / "source-canonical.mp4"
    try:
        _merge_uploaded_chunks(upload_id, manifest_snapshot, merged_path)
        source_path, video_metadata = prepare_video_source(merged_path, canonical_path)
    except Exception as error:
        logger.exception("Failed to prepare uploaded source %s", upload_id)
        _mark_failed(upload_id, str(error) or "Could not inspect uploaded video")
        raise UploadError(str(error) or "Could not inspect uploaded video") from error

    with _get_upload_lock(upload_id):
        manifest = _read_manifest(upload_id)
        manifest["sourceType"] = "uploaded_file"
        manifest["sourcePath"] = str(source_path)
        manifest["sourceOriginalPath"] = str(merged_path)
        manifest["previewVideo"] = _build_preview_video(
            upload_id,
            video_metadata.width or 1280,
            video_metadata.height or 720,
        )
        manifest["sourceDurationSec"] = float(video_metadata.duration_sec or 0)
        manifest["status"] = "uploaded"
        manifest["error"] = None
        _write_manifest(upload_id, manifest)
        return _serialize_manifest(manifest)


def _read_manifest(upload_id: str) -> dict:
    manifest_path = _get_manifest_path(upload_id)
    if not manifest_path.exists():
        raise UploadNotFoundError()
    with open(manifest_path, "r", encoding="utf-8") as in_f:
        return json.load(in_f)


def _write_manifest(upload_id: str, manifest: dict) -> dict:
    upload_dir = _get_upload_dir(upload_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = _get_manifest_path(upload_id)
    temp_path = manifest_path.with_suffix(".tmp")
    with open(temp_path, "w", encoding="utf-8") as out_f:
        json.dump(manifest, out_f, ensure_ascii=True)
    os.replace(temp_path, manifest_path)
    return manifest


def _serialize_manifest(manifest: dict) -> dict:
    return {
        "uploadId": manifest["uploadId"],
        "status": manifest["status"],
        "uploadedBytes": manifest["uploadedBytes"],
        "totalBytes": manifest["totalBytes"],
        "chunkSizeBytes": manifest["chunkSizeBytes"],
        "error": manifest.get("error"),
        "video": manifest.get("video"),
        "previewVideo": manifest.get("previewVideo"),
        "sourceDurationSec": manifest.get("sourceDurationSec"),
    }


def _cleanup_intermediate_files(upload_id: str) -> None:
    upload_dir = _get_upload_dir(upload_id)
    if not upload_dir.exists():
        return

    for part_path in upload_dir.glob("part-*"):
        part_path.unlink(missing_ok=True)

    for merged_path in upload_dir.glob("merged-input*"):
        merged_path.unlink(missing_ok=True)


def _ensure_upload_writable(manifest: dict) -> None:
    status = manifest["status"]
    if status == "processing":
        raise UploadConflictError("Upload is already processing")
    if status == "uploaded":
        raise UploadConflictError("Upload is already complete")
    if status == "ready":
        raise UploadConflictError("Upload has already completed")
    if status == "failed":
        raise UploadConflictError("Upload failed and cannot accept more chunks")


def _ensure_can_prepare_clip(manifest: dict) -> None:
    status = manifest["status"]
    if status == "processing":
        raise UploadConflictError("Upload is already processing")
    if status == "ready":
        raise UploadConflictError("Upload has already completed")
    if status == "failed":
        raise UploadConflictError("Upload failed and cannot be retried")


def _parse_optional_time(value: Optional[float], field_name: str) -> Optional[float]:
    if value is None:
        return None

    try:
        normalized_value = float(value)
    except (TypeError, ValueError) as error:
        raise UploadError(f"{field_name} must be a finite number") from error

    if not math.isfinite(normalized_value):
        raise UploadError(f"{field_name} must be a finite number")

    return normalized_value


def _normalize_requested_clip_bounds(
    start_time_sec: Optional[float],
    end_time_sec: Optional[float],
) -> tuple[float, Optional[float]]:
    normalized_start_time_sec = _parse_optional_time(start_time_sec, "startTimeSec")
    normalized_end_time_sec = _parse_optional_time(end_time_sec, "endTimeSec")

    if normalized_start_time_sec is None:
        normalized_start_time_sec = 0.0

    if normalized_start_time_sec < 0:
        raise UploadError("startTimeSec must be greater than or equal to 0")

    if normalized_end_time_sec is not None:
        if normalized_end_time_sec <= normalized_start_time_sec:
            raise UploadError("endTimeSec must be greater than startTimeSec")
        if (
            normalized_end_time_sec - normalized_start_time_sec
            > MAX_UPLOAD_VIDEO_DURATION
        ):
            raise UploadError(
                "The selected clip cannot exceed "
                f"{int(MAX_UPLOAD_VIDEO_DURATION)} seconds"
            )

    return normalized_start_time_sec, normalized_end_time_sec


def _resolve_processing_clip_range(
    merged_path: Path,
    start_time_sec: Optional[float],
    end_time_sec: Optional[float],
) -> tuple[float, float]:
    source_metadata = get_video_metadata(str(merged_path))
    source_duration_sec = source_metadata.duration_sec
    if source_duration_sec is None or source_duration_sec <= 0:
        raise UploadError("Could not determine the uploaded video duration")

    normalized_start_time_sec = 0.0 if start_time_sec is None else start_time_sec
    if normalized_start_time_sec >= source_duration_sec:
        raise UploadError("The selected clip starts after the uploaded video ends")

    if end_time_sec is None:
        normalized_end_time_sec = min(
            source_duration_sec,
            normalized_start_time_sec + MAX_UPLOAD_VIDEO_DURATION,
        )
    else:
        normalized_end_time_sec = min(source_duration_sec, end_time_sec)

    duration_time_sec = normalized_end_time_sec - normalized_start_time_sec
    if duration_time_sec <= 0:
        raise UploadError(
            "The selected clip is empty after clamping to the uploaded video duration"
        )

    return normalized_start_time_sec, duration_time_sec


def list_server_files(path_value: Optional[str] = None) -> dict:
    current_path = _resolve_server_path(path_value, require_dir=True)
    entries = []

    try:
        with os.scandir(current_path) as scandir_entries:
            for entry in scandir_entries:
                try:
                    entry_path = Path(entry.path).resolve(strict=True)
                except (FileNotFoundError, PermissionError, OSError):
                    continue

                if not _is_within_root(entry_path, SERVER_VIDEO_BROWSER_ROOT):
                    continue

                if entry_path.is_dir():
                    entries.append(
                        {
                            "name": entry_path.name or str(entry_path),
                            "path": str(entry_path),
                            "type": "directory",
                        }
                    )
                    continue

                if entry_path.is_file() and _is_supported_server_video(entry_path):
                    try:
                        size_bytes = entry_path.stat().st_size
                    except OSError:
                        continue

                    entries.append(
                        {
                            "name": entry_path.name,
                            "path": str(entry_path),
                            "type": "file",
                            "sizeBytes": size_bytes,
                        }
                    )
    except PermissionError as error:
        raise UploadError("path is not accessible", 403) from error
    except OSError as error:
        raise UploadError("could not list directory contents") from error

    entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))

    parent_path: Optional[str] = None
    if current_path != SERVER_VIDEO_BROWSER_ROOT:
        parent_path = str(current_path.parent)

    return {
        "rootPath": str(SERVER_VIDEO_BROWSER_ROOT),
        "currentPath": str(current_path),
        "parentPath": parent_path,
        "entries": entries,
    }


def _resolve_relative_video_path(path_value: str) -> Path:
    normalized_path = path_value.replace("\\", "/").lstrip("/")
    if not normalized_path:
        raise UploadError("videoPath is required")

    candidate_path = (DATA_PATH / Path(normalized_path)).resolve(strict=False)
    if not _is_within_root(candidate_path, DATA_PATH.resolve()):
        raise UploadError("videoPath is outside the allowed data root", 403)

    if not candidate_path.exists() or not candidate_path.is_file():
        raise UploadError("videoPath does not exist", 404)

    return candidate_path


def _resolve_video_export_source_path(
    video_path_value: Optional[str],
    upload_id_value: Optional[str],
) -> Path:
    if isinstance(video_path_value, str) and video_path_value.strip():
        raw_video_path = video_path_value.strip()
        candidate_path = Path(raw_video_path).expanduser()
        if candidate_path.is_absolute():
            return _resolve_server_path(raw_video_path, require_file=True)

        if raw_video_path.startswith(f"{GALLERY_PREFIX}/") or raw_video_path.startswith(
            f"{UPLOADS_PREFIX}/"
        ):
            resolved_path = _resolve_relative_video_path(raw_video_path)
            if not _is_supported_server_video(resolved_path):
                raise UploadError("videoPath is not a supported video file")
            return resolved_path

        raise UploadError("videoPath must be absolute or a gallery/uploads media path")

    if isinstance(upload_id_value, str) and upload_id_value.strip():
        with _get_upload_lock(upload_id_value):
            manifest = _read_manifest(upload_id_value)

        if manifest.get("sourcePath"):
            try:
                return _resolve_manifest_source_path(manifest.get("sourcePath"))
            except UploadNotFoundError:
                logger.info(
                    "Upload sourcePath for %s was cleaned up; falling back to ready video path",
                    upload_id_value,
                )

        video = manifest.get("video")
        if isinstance(video, dict) and isinstance(video.get("path"), str):
            resolved_path = _resolve_relative_video_path(str(video["path"]))
            if not _is_supported_server_video(resolved_path):
                raise UploadError("uploadId does not resolve to a supported video file")
            return resolved_path

    raise UploadError("Could not resolve the source video for export")


def _normalize_positive_frame_count(value: object, fallback: int) -> int:
    try:
        frame_count = int(value)
    except (TypeError, ValueError):
        frame_count = int(fallback or 0)

    if frame_count <= 0:
        raise UploadError("totalFrames must be greater than zero")

    return frame_count


def _normalize_trim_end_frame(value: object, total_frames: int) -> int:
    try:
        trim_end_frame = int(value)
    except (TypeError, ValueError) as error:
        raise UploadError("trimEndFrameExclusive must be an integer") from error

    return min(max(0, trim_end_frame), total_frames)


def export_remainder_video(
    *,
    video_path_value: Optional[str],
    upload_id_value: Optional[str],
    trim_end_frame_exclusive_value: object,
    total_frames_value: object,
) -> dict:
    source_video_path = _resolve_video_export_source_path(
        video_path_value,
        upload_id_value,
    )

    try:
        source_metadata = inspect_video_path(source_video_path)
    except Exception as error:
        logger.exception("Failed to inspect source video for remainder export: %s", source_video_path)
        raise UploadError("Could not inspect the source video for the remaining segment", 500) from error

    source_duration_sec = source_metadata.duration_sec
    if source_duration_sec is None or source_duration_sec <= 0:
        raise UploadError("Could not determine the source video duration")

    total_frames = _normalize_positive_frame_count(
        total_frames_value,
        source_metadata.num_video_frames,
    )
    trim_end_frame_exclusive = _normalize_trim_end_frame(
        trim_end_frame_exclusive_value,
        total_frames,
    )
    remaining_frames = total_frames - trim_end_frame_exclusive
    if remaining_frames <= 0:
        return {
            "hasRemainder": False,
            "video": None,
            "trimEndFrameExclusive": trim_end_frame_exclusive,
            "totalFrames": total_frames,
        }

    start_time_sec = source_duration_sec * (trim_end_frame_exclusive / total_frames)
    duration_time_sec = max(0.0, source_duration_sec - start_time_sec)
    if duration_time_sec <= 0:
        return {
            "hasRemainder": False,
            "video": None,
            "trimEndFrameExclusive": trim_end_frame_exclusive,
            "totalFrames": total_frames,
        }

    try:
        filepath, file_key, video_metadata = process_video_path(
            source_video_path,
            start_time_sec=start_time_sec,
            duration_time_sec=duration_time_sec,
        )
        video = build_uploaded_video(filepath, file_key, video_metadata)
    except Exception as error:
        logger.exception("Failed to export remaining segment for %s", source_video_path)
        raise UploadError("Could not prepare the remaining video segment", 500) from error

    return {
        "hasRemainder": True,
        "video": serialize_video(video),
        "trimEndFrameExclusive": trim_end_frame_exclusive,
        "totalFrames": total_frames,
        "startTimeSec": start_time_sec,
        "durationTimeSec": duration_time_sec,
    }


def _frame_stem(frame_index: int) -> str:
    return f"{frame_index:0{ANNOTATION_EXPORT_FRAME_DIGITS}d}"


def _is_regular_frame_sequence(frame_indices: Sequence[int]) -> bool:
    if len(frame_indices) <= 2:
        return True

    step = frame_indices[1] - frame_indices[0]
    if step <= 0:
        return False

    return all(
        frame_indices[index] - frame_indices[index - 1] == step
        for index in range(2, len(frame_indices))
    )


def _build_frame_select_expression(frame_indices: Sequence[int]) -> str:
    if len(frame_indices) == 0:
        raise UploadError("No frame indices were provided for export")

    if _is_regular_frame_sequence(frame_indices):
        start = frame_indices[0]
        end = frame_indices[-1]
        if len(frame_indices) == 1:
            return f"eq(n\,{start})"

        step = frame_indices[1] - frame_indices[0]
        if step == 1:
            return f"between(n\,{start}\,{end})"
        return f"between(n\,{start}\,{end})*not(mod(n-{start}\,{step}))"

    return "+".join(f"eq(n\,{frame_index})" for frame_index in frame_indices)


def _format_export_dir_value(value: float) -> str:
    if float(value).is_integer():
        return str(int(value))
    return f"{value:g}".replace(".", "p")


def _iter_frame_batches(frame_indices: Sequence[int]) -> list[Sequence[int]]:
    if len(frame_indices) == 0:
        return []

    if _is_regular_frame_sequence(frame_indices):
        return [frame_indices]

    batch_size = max(1, ANNOTATION_EXPORT_FFMPEG_BATCH_SIZE)
    return [
        frame_indices[offset : offset + batch_size]
        for offset in range(0, len(frame_indices), batch_size)
    ]


def _run_ffmpeg_frame_batch(
    video_path: Path,
    frame_indices: Sequence[int],
    batch_dir: Path,
) -> list[Path]:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise UploadError("ffmpeg is not available on the server", 500)

    batch_dir.mkdir(parents=True, exist_ok=False)
    output_pattern = batch_dir / "%06d.jpg"
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        f"select={_build_frame_select_expression(frame_indices)}",
        "-vsync",
        "0",
        "-frames:v",
        str(len(frame_indices)),
        "-q:v",
        str(ANNOTATION_EXPORT_JPEG_QUALITY),
        "-start_number",
        "0",
        str(output_pattern),
    ]

    result = subprocess.run(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise UploadError(
            "Could not export frames "
            f"{frame_indices[0]}-{frame_indices[-1]}: "
            f"{result.stderr.strip() or 'ffmpeg failed'}",
            500,
        )

    output_files = sorted(batch_dir.glob("*.jpg"))
    if len(output_files) != len(frame_indices):
        raise UploadError(
            "Could not export the requested frame count: "
            f"expected {len(frame_indices)}, got {len(output_files)}",
            500,
        )

    return output_files


def _export_frame_images(
    video_path: Path,
    frame_indices: Sequence[int],
    images_dir: Path,
) -> int:
    if len(frame_indices) == 0:
        return 0

    unique_frame_indices = sorted(set(frame_indices))
    batch_count = 0
    for batch_index, batch in enumerate(_iter_frame_batches(unique_frame_indices)):
        batch_count += 1
        batch_dir = images_dir / f".ffmpeg_batch_{batch_index:04d}"
        try:
            output_files = _run_ffmpeg_frame_batch(video_path, batch, batch_dir)
            for output_file, frame_index in zip(output_files, batch):
                os.replace(output_file, images_dir / f"{_frame_stem(frame_index)}.jpg")
        finally:
            shutil.rmtree(batch_dir, ignore_errors=True)

    return batch_count


def _get_annotation_mask_color(object_id: object) -> tuple[int, int, int]:
    try:
        color_index = int(object_id)
    except (TypeError, ValueError):
        color_index = 0
    return ANNOTATION_EXPORT_MASK_COLORS[
        color_index % len(ANNOTATION_EXPORT_MASK_COLORS)
    ]


def _decode_annotation_mask(annotation: dict) -> np.ndarray:
    rle = annotation.get("rle")
    if not isinstance(rle, dict):
        raise UploadError("annotation.rle must be a JSON object")

    size = rle.get("size")
    counts = rle.get("counts")
    if (
        not isinstance(size, list)
        or len(size) != 2
        or not all(isinstance(value, int) and value > 0 for value in size)
        or not isinstance(counts, str)
    ):
        raise UploadError("annotation.rle must contain size and counts")

    decoded_mask = decode_masks({"size": size, "counts": counts})
    if decoded_mask.ndim == 3:
        decoded_mask = decoded_mask[:, :, 0]
    return np.asarray(decoded_mask, dtype=np.uint8) > 0


def _annotation_sort_key(annotation: object) -> int:
    if not isinstance(annotation, dict):
        return 0
    try:
        return int(annotation.get("object_id") or 0)
    except (TypeError, ValueError):
        return 0


def _write_masked_image(
    image_path: Path,
    masked_image_path: Path,
    annotations: Sequence[dict],
) -> None:
    if len(annotations) == 0:
        shutil.copyfile(image_path, masked_image_path)
        return

    base_image = Image.open(image_path).convert("RGBA")
    did_apply_mask = False
    for annotation in sorted(annotations, key=_annotation_sort_key):
        if not isinstance(annotation, dict):
            raise UploadError("frame annotations must be JSON objects")

        mask = _decode_annotation_mask(annotation)
        if not mask.any():
            continue

        mask_image = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
        if mask_image.size != base_image.size:
            resampling = getattr(Image, "Resampling", Image)
            mask_image = mask_image.resize(base_image.size, resampling.NEAREST)

        color_layer = Image.new(
            "RGBA",
            base_image.size,
            (*_get_annotation_mask_color(annotation.get("object_id")), 0),
        )
        color_layer.putalpha(
            mask_image.point(lambda value: ANNOTATION_EXPORT_MASK_ALPHA if value else 0)
        )
        base_image = Image.alpha_composite(base_image, color_layer)
        did_apply_mask = True

    if not did_apply_mask:
        shutil.copyfile(image_path, masked_image_path)
        return

    base_image.convert("RGB").save(
        masked_image_path,
        "JPEG",
        quality=ANNOTATION_EXPORT_MASKED_IMAGE_JPEG_QUALITY,
    )


def _normalize_annotation_export_frames(
    frames: object,
    *,
    reject_duplicate_indices: bool = False,
) -> list[dict]:
    if not isinstance(frames, list):
        raise UploadError("payload.frames must be an array")

    frames_by_index = {}
    for frame in frames:
        if not isinstance(frame, dict):
            raise UploadError("payload.frames entries must be JSON objects")
        frame_index = frame.get("frame_index")
        annotations = frame.get("annotations", [])
        if type(frame_index) is not int or frame_index < 0:
            raise UploadError("payload.frames[].frame_index must be a non-negative integer")
        if not isinstance(annotations, list):
            raise UploadError("payload.frames[].annotations must be an array")
        if frame_index in frames_by_index:
            if reject_duplicate_indices:
                raise UploadError(
                    f"payload.frames contains duplicate frame_index {frame_index}"
                )
            continue

        frames_by_index[frame_index] = {
            "frame_index": frame_index,
            "annotations": annotations,
        }

    return [frames_by_index[index] for index in sorted(frames_by_index)]


def _normalize_optional_positive_float(value: object, field_name: str) -> float:
    try:
        normalized_value = float(value)
    except (TypeError, ValueError) as error:
        raise UploadError(f"{field_name} must be a positive number") from error

    if not math.isfinite(normalized_value) or normalized_value <= 0:
        raise UploadError(f"{field_name} must be a positive number")

    return normalized_value


def _normalize_frame_list_file_name(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise UploadError("payload.export_frame_list_file_name is required")
    return value.strip()


def _normalize_export_frame_indices(value: object) -> list[int]:
    if not isinstance(value, list) or len(value) == 0:
        raise UploadError("payload.export_frame_indices must be a non-empty array")

    frame_indices = []
    seen_frame_indices = set()
    for frame_index in value:
        if type(frame_index) is not int or frame_index < 0:
            raise UploadError(
                "payload.export_frame_indices entries must be non-negative integers"
            )
        if frame_index in seen_frame_indices:
            raise UploadError(
                f"payload.export_frame_indices contains duplicate frame_index {frame_index}"
            )
        seen_frame_indices.add(frame_index)
        frame_indices.append(frame_index)

    return frame_indices


def _validate_frame_indices_within_video(
    frame_indices: Sequence[int],
    total_frames: int,
) -> None:
    if total_frames <= 0 or len(frame_indices) == 0:
        return

    max_frame_index = total_frames - 1
    for frame_index in frame_indices:
        if frame_index > max_frame_index:
            raise UploadError(
                f"frame index {frame_index} is outside the video range 0-{max_frame_index}"
            )


def _normalize_export_sampling_metadata(
    payload: dict,
    *,
    export_every_n_frames: int,
    source_fps: float,
    frames: Sequence[dict],
) -> tuple[str, dict]:
    sampling_mode = str(payload.get("export_sampling_mode") or "frames").strip()
    if sampling_mode not in {"frames", "seconds", "frame_list"}:
        raise UploadError(
            "payload.export_sampling_mode must be frames, seconds, or frame_list"
        )

    metadata = {
        "export_sampling_mode": sampling_mode,
        "export_every_n_frames": export_every_n_frames,
        "export_source_fps": source_fps,
    }

    if sampling_mode == "frame_list":
        requested_frame_indices = _normalize_export_frame_indices(
            payload.get("export_frame_indices")
        )
        payload_frame_indices = [frame["frame_index"] for frame in frames]
        if requested_frame_indices != payload_frame_indices:
            raise UploadError(
                "payload.export_frame_indices must exactly match payload.frames[].frame_index"
            )
        metadata["export_frame_list_file_name"] = _normalize_frame_list_file_name(
            payload.get("export_frame_list_file_name")
        )
        metadata["export_frame_indices"] = requested_frame_indices
        return "frame_list", metadata

    if sampling_mode == "seconds":
        every_n_seconds = _normalize_optional_positive_float(
            payload.get("export_every_n_seconds"),
            "payload.export_every_n_seconds",
        )
        payload_source_fps = payload.get("export_source_fps")
        if payload_source_fps is not None:
            metadata["export_source_fps"] = _normalize_optional_positive_float(
                payload_source_fps,
                "payload.export_source_fps",
            )
        metadata["export_every_n_seconds"] = every_n_seconds
        return (
            f"every_{_format_export_dir_value(every_n_seconds)}_seconds",
            metadata,
        )

    return f"every_{export_every_n_frames}_frames", metadata


def export_annotations_file(
    directory_path_value: str,
    payload: object,
    *,
    video_path_value: Optional[str] = None,
    upload_id_value: Optional[str] = None,
) -> dict:
    if not directory_path_value:
        raise UploadError("directoryPath is required")
    if not isinstance(payload, dict):
        raise UploadError("payload must be a JSON object")

    directory_path = _resolve_server_path(directory_path_value, require_dir=True)
    if not os.access(directory_path, os.W_OK | os.X_OK):
        raise UploadError("path is not writable", 403)

    export_every_n_frames = payload.get("export_every_n_frames", 1)
    try:
        normalized_export_every_n_frames = max(1, int(export_every_n_frames))
    except (TypeError, ValueError) as error:
        raise UploadError("payload.export_every_n_frames must be an integer") from error

    source_video_path = _resolve_video_export_source_path(video_path_value, upload_id_value)
    source_video_metadata = get_video_metadata(str(source_video_path))
    fps = source_video_metadata.fps
    width = source_video_metadata.width
    height = source_video_metadata.height
    if fps is None or not math.isfinite(fps) or fps <= 0:
        raise UploadError("Could not determine the source video fps")
    if width is None or height is None:
        raise UploadError("Could not determine the source video dimensions")

    sampling_mode = str(payload.get("export_sampling_mode") or "frames").strip()
    frames = _normalize_annotation_export_frames(
        payload.get("frames"),
        reject_duplicate_indices=sampling_mode == "frame_list",
    )
    frame_indices = [frame["frame_index"] for frame in frames]
    if sampling_mode == "frame_list":
        _validate_frame_indices_within_video(
            frame_indices,
            source_video_metadata.num_video_frames,
        )

    export_sampling_dir_component, export_sampling_metadata = (
        _normalize_export_sampling_metadata(
            payload,
            export_every_n_frames=normalized_export_every_n_frames,
            source_fps=float(fps),
            frames=frames,
        )
    )
    timestamp_ms = int(time.time() * 1000)
    export_dir_name = (
        f"{ANNOTATION_EXPORT_DIRNAME_PREFIX}_{export_sampling_dir_component}_"
        f"{timestamp_ms}"
    )
    export_dir = directory_path / export_dir_name
    temp_dir = directory_path / f".{export_dir_name}.tmp"
    images_dir = temp_dir / ANNOTATION_EXPORT_IMAGES_DIRNAME
    annotations_dir = temp_dir / ANNOTATION_EXPORT_ANNOTATIONS_DIRNAME
    masked_images_dir = temp_dir / ANNOTATION_EXPORT_MASKED_IMAGES_DIRNAME

    manifest_frames = []
    total_bytes = 0
    started_at = time.perf_counter()
    ffmpeg_duration_ms = 0
    annotation_write_duration_ms = 0
    masked_image_duration_ms = 0

    try:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
        images_dir.mkdir(parents=True, exist_ok=False)
        annotations_dir.mkdir(parents=True, exist_ok=False)
        masked_images_dir.mkdir(parents=True, exist_ok=False)

        ffmpeg_started_at = time.perf_counter()
        ffmpeg_batch_count = _export_frame_images(
            source_video_path,
            frame_indices,
            images_dir,
        )
        ffmpeg_duration_ms = round((time.perf_counter() - ffmpeg_started_at) * 1000)

        annotation_write_started_at = time.perf_counter()
        for frame in frames:
            frame_index = frame.get("frame_index")
            annotations = frame.get("annotations", [])

            frame_stem = _frame_stem(frame_index)
            image_file_name = f"{frame_stem}.jpg"
            annotation_file_name = f"{frame_stem}.json"
            masked_image_file_name = f"{frame_stem}.jpg"
            image_path = images_dir / image_file_name
            annotation_path = annotations_dir / annotation_file_name
            masked_image_path = masked_images_dir / masked_image_file_name

            if not image_path.is_file():
                raise UploadError(f"Could not export frame {frame_index}", 500)

            frame_payload = {
                "session_id": payload.get("session_id"),
                "frame_index": frame_index,
                "image_file": image_file_name,
                "image_width": width,
                "image_height": height,
                "annotations": annotations,
            }
            with open(annotation_path, "w", encoding="utf-8") as out_f:
                json.dump(frame_payload, out_f, ensure_ascii=False, indent=2)

            masked_image_started_at = time.perf_counter()
            _write_masked_image(image_path, masked_image_path, annotations)
            masked_image_duration_ms += round(
                (time.perf_counter() - masked_image_started_at) * 1000
            )

            total_bytes += image_path.stat().st_size
            total_bytes += annotation_path.stat().st_size
            total_bytes += masked_image_path.stat().st_size
            manifest_frames.append(
                {
                    "frame_index": frame_index,
                    "image_file": f"{ANNOTATION_EXPORT_IMAGES_DIRNAME}/{image_file_name}",
                    "annotation_file": f"{ANNOTATION_EXPORT_ANNOTATIONS_DIRNAME}/{annotation_file_name}",
                    "masked_image_file": f"{ANNOTATION_EXPORT_MASKED_IMAGES_DIRNAME}/{masked_image_file_name}",
                }
            )
        annotation_write_duration_ms = round(
            (time.perf_counter() - annotation_write_started_at) * 1000
        )

        manifest = {
            "session_id": payload.get("session_id"),
            "source_video": str(source_video_path),
            **export_sampling_metadata,
            "frame_count": len(manifest_frames),
            "image_format": "jpg",
            "jpeg_quality": ANNOTATION_EXPORT_JPEG_QUALITY,
            "images_dir": ANNOTATION_EXPORT_IMAGES_DIRNAME,
            "annotations_dir": ANNOTATION_EXPORT_ANNOTATIONS_DIRNAME,
            "masked_images_dir": ANNOTATION_EXPORT_MASKED_IMAGES_DIRNAME,
            "frames": manifest_frames,
        }
        temp_manifest_path = temp_dir / MANIFEST_FILENAME
        with open(temp_manifest_path, "w", encoding="utf-8") as out_f:
            json.dump(manifest, out_f, ensure_ascii=False, indent=2)
        total_bytes += temp_manifest_path.stat().st_size

        os.replace(temp_dir, export_dir)
        logger.info(
            "Exported annotations frames=%s ffmpeg_batches=%s bytes=%s "
            "ffmpeg_ms=%s annotation_json_ms=%s masked_image_ms=%s "
            "duration_ms=%s dir=%s",
            len(manifest_frames),
            ffmpeg_batch_count,
            total_bytes,
            ffmpeg_duration_ms,
            annotation_write_duration_ms,
            masked_image_duration_ms,
            round((time.perf_counter() - started_at) * 1000),
            export_dir,
        )
    except PermissionError as error:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise UploadError("path is not writable", 403) from error
    except UploadError:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    except OSError as error:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise UploadError("could not write annotation export", 500) from error

    manifest_path = export_dir / MANIFEST_FILENAME
    return {
        "savedPath": str(export_dir),
        "exportDir": str(export_dir),
        "fileName": export_dir_name,
        "bytes": total_bytes,
        "imageCount": len(manifest_frames),
        "annotationCount": len(manifest_frames),
        "manifestPath": str(manifest_path),
        "durationMs": round((time.perf_counter() - started_at) * 1000),
        "ffmpegDurationMs": ffmpeg_duration_ms,
        "annotationJsonDurationMs": annotation_write_duration_ms,
        "maskedImageDurationMs": masked_image_duration_ms,
    }


def _get_archive_compression(file_path: Path) -> int:
    if file_path.suffix.lower() in ANNOTATION_EXPORT_STORED_ARCHIVE_SUFFIXES:
        return zipfile.ZIP_STORED
    return zipfile.ZIP_DEFLATED


def export_annotations_archive_file(
    payload: object,
    *,
    video_path_value: Optional[str] = None,
    upload_id_value: Optional[str] = None,
) -> dict:
    temp_parent = UPLOAD_SESSIONS_PATH / f".annotation-export-{uuid.uuid4().hex}"
    temp_parent.mkdir(parents=True, exist_ok=False)
    try:
        export_result = export_annotations_file(
            str(temp_parent),
            payload,
            video_path_value=video_path_value,
            upload_id_value=upload_id_value,
        )
        export_dir = Path(export_result["exportDir"])
        file_name = f"{export_dir.name}.zip"
        archive_buffer = io.BytesIO()
        archive_started_at = time.perf_counter()
        with zipfile.ZipFile(
            archive_buffer,
            mode="w",
        ) as archive:
            for file_path in sorted(export_dir.rglob("*")):
                if not file_path.is_file():
                    continue
                archive.write(
                    file_path,
                    str(Path(export_dir.name) / file_path.relative_to(export_dir)),
                    compress_type=_get_archive_compression(file_path),
                )
        archive_duration_ms = round((time.perf_counter() - archive_started_at) * 1000)
        archive_bytes = archive_buffer.getvalue()
        logger.info(
            "Archived annotations file=%s bytes=%s archive_ms=%s total_ms=%s",
            file_name,
            len(archive_bytes),
            archive_duration_ms,
            export_result.get("durationMs"),
        )

        return {
            "bytes": archive_bytes,
            "exportDir": export_dir.name,
            "fileName": file_name,
        }
    finally:
        shutil.rmtree(temp_parent, ignore_errors=True)


def import_server_video(path_value: str) -> dict:
    original_source_path = _resolve_server_path(path_value, require_file=True)
    if not _is_supported_server_video(original_source_path):
        raise UploadError(
            "Unsupported video type. Please choose an MP4, MOV, M4V, AVI, MKV, WEBM, or DAT file."
        )

    size_bytes = original_source_path.stat().st_size
    if size_bytes <= 0:
        raise UploadError(f"selected file is empty: {original_source_path}")
    _validate_upload_file_size(size_bytes)

    upload_id = uuid.uuid4().hex
    canonical_path = _get_upload_dir(upload_id) / "source-canonical.mp4"
    try:
        source_path, video_metadata = prepare_video_source(
            original_source_path,
            canonical_path,
        )
    except Exception as error:
        shutil.rmtree(_get_upload_dir(upload_id), ignore_errors=True)
        logger.exception("Failed to inspect server video metadata for %s", original_source_path)
        raise UploadError(
            f"Failed to inspect the selected video metadata for {original_source_path}: "
            f"{str(error) or 'unknown error'}"
        ) from error

    manifest = {
        "uploadId": upload_id,
        "filename": original_source_path.name,
        "contentType": mimetypes.guess_type(str(original_source_path))[0]
        or "application/octet-stream",
        "totalBytes": int(size_bytes),
        "uploadedBytes": int(size_bytes),
        "chunkSizeBytes": 0,
        "totalChunks": 0,
        "nextChunkIndex": 0,
        "status": "uploaded",
        "error": None,
        "video": None,
        "previewVideo": _build_preview_video(
            upload_id,
            video_metadata.width or 1280,
            video_metadata.height or 720,
        ),
        "sourceDurationSec": float(video_metadata.duration_sec or 0),
        "clipStartTimeSec": None,
        "clipEndTimeSec": None,
        "sourceType": "server_file",
        "sourcePath": str(source_path),
        "sourceOriginalPath": str(original_source_path),
    }
    _write_manifest(upload_id, manifest)
    return _serialize_manifest(manifest)


def get_upload_source_path(upload_id: str) -> Path:
    with _get_upload_lock(upload_id):
        manifest = _read_manifest(upload_id)

    return _resolve_manifest_source_path(manifest.get("sourcePath"))


def create_upload_session(
    filename: str,
    size_bytes: int,
    content_type: str,
) -> dict:
    if not filename:
        raise UploadError("filename is required")
    if size_bytes <= 0:
        raise UploadError("sizeBytes must be greater than zero")
    _validate_upload_file_size(size_bytes)

    upload_id = uuid.uuid4().hex
    manifest = {
        "uploadId": upload_id,
        "filename": filename,
        "contentType": content_type or "application/octet-stream",
        "totalBytes": int(size_bytes),
        "uploadedBytes": 0,
        "chunkSizeBytes": UPLOAD_CHUNK_SIZE_BYTES,
        "totalChunks": _expected_chunk_count(size_bytes, UPLOAD_CHUNK_SIZE_BYTES),
        "nextChunkIndex": 0,
        "status": "uploading",
        "error": None,
        "video": None,
        "clipStartTimeSec": None,
        "clipEndTimeSec": None,
    }
    _write_manifest(upload_id, manifest)
    return _serialize_manifest(manifest)


def write_upload_chunk(upload_id: str, index: int, chunk: bytes) -> dict:
    if len(chunk) == 0:
        raise UploadError("chunk body is empty")

    with _get_upload_lock(upload_id):
        manifest = _read_manifest(upload_id)
        _ensure_upload_writable(manifest)

        total_chunks = manifest["totalChunks"]
        if index < 0 or index >= total_chunks:
            raise UploadError("chunk index out of range")
        if index != manifest["nextChunkIndex"]:
            raise UploadConflictError(
                f"expected chunk index {manifest['nextChunkIndex']}, got {index}"
            )

        chunk_size = manifest["chunkSizeBytes"]
        total_bytes = manifest["totalBytes"]
        expected_size = min(chunk_size, total_bytes - (index * chunk_size))
        if len(chunk) != expected_size:
            raise UploadError(
                f"invalid chunk size for index {index}: expected {expected_size} bytes"
            )

        part_path = _get_part_path(upload_id, index)
        with open(part_path, "wb") as out_f:
            out_f.write(chunk)

        manifest["nextChunkIndex"] = index + 1
        manifest["uploadedBytes"] += len(chunk)
        completed_upload = (
            manifest["nextChunkIndex"] == manifest["totalChunks"]
            and manifest["uploadedBytes"] == manifest["totalBytes"]
        )
        if completed_upload:
            manifest["status"] = "uploaded"
        else:
            manifest["status"] = "uploading"
        manifest["error"] = None
        _write_manifest(upload_id, manifest)
        serialized_manifest = _serialize_manifest(manifest)

    if completed_upload:
        return _prepare_uploaded_source(upload_id)
    return serialized_manifest


def get_upload_session(upload_id: str) -> dict:
    with _get_upload_lock(upload_id):
        manifest = _read_manifest(upload_id)
        return _serialize_manifest(manifest)


def _mark_failed(upload_id: str, error_message: str) -> None:
    try:
        with _get_upload_lock(upload_id):
            manifest = _read_manifest(upload_id)
            manifest["status"] = "failed"
            manifest["error"] = error_message
            _write_manifest(upload_id, manifest)
    except UploadNotFoundError:
        return


def _process_upload(upload_id: str) -> None:
    source_path: Optional[Path] = None
    is_server_file = False

    try:
        with _get_upload_lock(upload_id):
            manifest = _read_manifest(upload_id)
            clip_start_time_sec = manifest.get("clipStartTimeSec")
            clip_end_time_sec = manifest.get("clipEndTimeSec")
            is_server_file = manifest.get("sourceType") == "server_file"
            manifest_source_path = manifest.get("sourcePath")
            manifest_snapshot = dict(manifest)

        if manifest_source_path:
            source_path = _resolve_manifest_source_path(manifest_source_path)
        else:
            upload_dir = _get_upload_dir(upload_id)
            input_suffix = Path(manifest_snapshot["filename"]).suffix or ".bin"
            merged_path = upload_dir / f"merged-input{input_suffix}"
            canonical_path = upload_dir / "source-canonical.mp4"
            _merge_uploaded_chunks(upload_id, manifest_snapshot, merged_path)
            source_path, video_metadata = prepare_video_source(merged_path, canonical_path)
            with _get_upload_lock(upload_id):
                manifest = _read_manifest(upload_id)
                manifest["sourceType"] = "uploaded_file"
                manifest["sourcePath"] = str(source_path)
                manifest["sourceOriginalPath"] = str(merged_path)
                manifest["previewVideo"] = _build_preview_video(
                    upload_id,
                    video_metadata.width or 1280,
                    video_metadata.height or 720,
                )
                manifest["sourceDurationSec"] = float(video_metadata.duration_sec or 0)
                _write_manifest(upload_id, manifest)

        if source_path is None:
            raise UploadError("Upload source is unavailable")

        normalized_start_time_sec, normalized_duration_time_sec = (
            _resolve_processing_clip_range(
                source_path,
                start_time_sec=clip_start_time_sec,
                end_time_sec=clip_end_time_sec,
            )
        )
        filepath, file_key, video_metadata = process_video_path(
            source_path,
            start_time_sec=normalized_start_time_sec,
            duration_time_sec=normalized_duration_time_sec,
        )
        video = build_uploaded_video(filepath, file_key, video_metadata)
        serialized_video = serialize_video(video)

        with _get_upload_lock(upload_id):
            manifest = _read_manifest(upload_id)
            manifest["status"] = "ready"
            manifest["uploadedBytes"] = manifest["totalBytes"]
            manifest["error"] = None
            manifest["video"] = serialized_video
            _write_manifest(upload_id, manifest)

        if not is_server_file:
            _cleanup_intermediate_files(upload_id)
    except Exception as error:
        logger.exception("Upload processing failed for %s", upload_id)
        _mark_failed(upload_id, str(error) or "Upload processing failed")


def complete_upload(
    upload_id: str,
    start_time_sec: Optional[float] = None,
    end_time_sec: Optional[float] = None,
) -> dict:
    normalized_start_time_sec, normalized_end_time_sec = (
        _normalize_requested_clip_bounds(start_time_sec, end_time_sec)
    )

    with _get_upload_lock(upload_id):
        manifest = _read_manifest(upload_id)
        _ensure_can_prepare_clip(manifest)

        if manifest["uploadedBytes"] != manifest["totalBytes"]:
            raise UploadError("Upload is incomplete")
        if manifest["nextChunkIndex"] != manifest["totalChunks"]:
            raise UploadError("Missing uploaded chunks")

        manifest["status"] = "processing"
        manifest["error"] = None
        manifest["clipStartTimeSec"] = normalized_start_time_sec
        manifest["clipEndTimeSec"] = normalized_end_time_sec
        _write_manifest(upload_id, manifest)

    thread = threading.Thread(
        target=_process_upload,
        args=(upload_id,),
        daemon=True,
        name=f"upload-session-{upload_id}",
    )
    thread.start()
    return _serialize_manifest(manifest)


def delete_upload_session(upload_id: str) -> None:
    with _get_upload_lock(upload_id):
        upload_dir = _get_upload_dir(upload_id)
        if not upload_dir.exists():
            raise UploadNotFoundError()
        shutil.rmtree(upload_dir, ignore_errors=True)
    _drop_upload_lock(upload_id)
