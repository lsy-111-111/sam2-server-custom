# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import hashlib
import os
import shutil
import tempfile
from pathlib import Path
from typing import IO, Optional, Tuple, Union

import av
from app_conf import MAX_UPLOAD_VIDEO_DURATION, UPLOADS_PATH, UPLOADS_PREFIX
from data.data_types import Video
from data.loader import get_video
from data.transcoder import (
    VideoMetadata,
    canonicalize_raw_hevc,
    get_video_metadata,
    is_raw_hevc_metadata,
    transcode,
)

ReadableVideoSource = Union[str, os.PathLike[str], IO[bytes]]


def get_file_hash(video_path_or_file: ReadableVideoSource) -> str:
    if isinstance(video_path_or_file, (str, os.PathLike)):
        with open(video_path_or_file, "rb") as in_f:
            return hashlib.sha256(in_f.read()).hexdigest()

    video_path_or_file.seek(0)
    return hashlib.sha256(video_path_or_file.read()).hexdigest()


def _get_start_sec_duration_sec(
    start_time_sec: Optional[float],
    duration_time_sec: Optional[float],
    max_time: float,
) -> Tuple[float, float]:
    default_seek_t = int(os.environ.get("VIDEO_ENCODE_SEEK_TIME", "0"))
    if start_time_sec is None:
        start_time_sec = default_seek_t

    if duration_time_sec is not None:
        duration_time_sec = min(duration_time_sec, max_time)
    else:
        duration_time_sec = max_time
    return start_time_sec, duration_time_sec


def _validate_video_metadata(video_metadata: VideoMetadata) -> None:
    if video_metadata.num_video_streams == 0:
        raise Exception("video container does not contain a video stream")
    if video_metadata.width is None or video_metadata.height is None:
        raise Exception("video container does not contain width or height metadata")
    if video_metadata.duration_sec in (None, 0):
        raise Exception("video container does time duration metadata")


def inspect_video_path(input_path: Union[str, Path]) -> VideoMetadata:
    input_path = str(input_path)

    try:
        video_metadata = get_video_metadata(input_path)
    except av.InvalidDataError as error:
        raise Exception("not valid video file") from error

    _validate_video_metadata(video_metadata)
    return video_metadata


def prepare_video_source(
    input_path: Union[str, Path],
    canonical_output_path: Union[str, Path],
) -> Tuple[Path, VideoMetadata]:
    source_path = Path(input_path)
    video_metadata = inspect_video_path(source_path)
    if not is_raw_hevc_metadata(video_metadata):
        return source_path, video_metadata

    canonical_path = Path(canonical_output_path)
    canonical_path.parent.mkdir(parents=True, exist_ok=True)
    canonicalize_raw_hevc(str(source_path), str(canonical_path), video_metadata)
    return canonical_path, inspect_video_path(canonical_path)


def process_video_path(
    input_path: Union[str, Path],
    max_time: float = MAX_UPLOAD_VIDEO_DURATION,
    start_time_sec: Optional[float] = None,
    duration_time_sec: Optional[float] = None,
) -> Tuple[str, str, VideoMetadata]:
    input_path = Path(input_path)

    with tempfile.TemporaryDirectory() as tempdir:
        prepared_input_path, video_metadata = prepare_video_source(
            input_path,
            Path(tempdir) / "source-canonical.mp4",
        )
        start_time_sec, duration_time_sec = _get_start_sec_duration_sec(
            max_time=max_time,
            start_time_sec=start_time_sec,
            duration_time_sec=duration_time_sec,
        )
        out_path = f"{tempdir}/out.mp4"

        transcode(
            str(prepared_input_path),
            out_path,
            video_metadata,
            seek_t=start_time_sec,
            duration_time_sec=duration_time_sec,
        )

        out_video_metadata = get_video_metadata(out_path)
        if out_video_metadata.num_video_frames == 0:
            raise Exception(
                "transcode produced empty video; check seek time or your input video"
            )

        with open(out_path, "rb") as file_data:
            file_hash = get_file_hash(file_data)
            file_key = UPLOADS_PREFIX + "/" + f"{file_hash}.mp4"
            filepath = os.path.join(UPLOADS_PATH, f"{file_hash}.mp4")

        if os.path.exists(filepath):
            os.remove(out_path)
        else:
            shutil.move(out_path, filepath)

    return filepath, file_key, out_video_metadata


def process_video_upload(
    file,
    max_time: float = MAX_UPLOAD_VIDEO_DURATION,
    start_time_sec: Optional[float] = None,
    duration_time_sec: Optional[float] = None,
) -> Tuple[str, str, VideoMetadata]:
    with tempfile.TemporaryDirectory() as tempdir:
        input_suffix = Path(getattr(file, "filename", "") or "").suffix or ".mp4"
        input_path = os.path.join(tempdir, f"in{input_suffix}")
        with open(input_path, "wb") as in_f:
            in_f.write(file.read())

        return process_video_path(
            input_path=input_path,
            max_time=max_time,
            start_time_sec=start_time_sec,
            duration_time_sec=duration_time_sec,
        )


def build_uploaded_video(
    filepath: str,
    file_key: str,
    video_metadata: VideoMetadata,
) -> Video:
    return get_video(
        filepath,
        UPLOADS_PATH,
        file_key=file_key,
        width=video_metadata.width,
        height=video_metadata.height,
        generate_poster=True,
    )


def serialize_video(video: Video) -> dict:
    return {
        "path": video.path,
        "posterPath": video.poster_path,
        "url": video.url(),
        "posterUrl": video.poster_url(),
        "width": video.width,
        "height": video.height,
    }
