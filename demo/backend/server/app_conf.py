# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

APP_ROOT = os.getenv("APP_ROOT", "/opt/sam2")

API_URL = os.getenv("API_URL", "")

MODEL_SIZE = os.getenv("MODEL_SIZE", "base_plus")

logger.info(f"using model size {MODEL_SIZE}")

FFMPEG_NUM_THREADS = int(os.getenv("FFMPEG_NUM_THREADS", "1"))

# Path for all data used in API
DATA_PATH = Path(os.getenv("DATA_PATH", "/data"))

# Root path exposed by the server-side video browser.
SERVER_VIDEO_BROWSER_ROOT = Path(
    os.getenv("SERVER_VIDEO_BROWSER_ROOT", "/")
).resolve()

# Max duration an uploaded video can have in seconds. The default is 600
# seconds.
MAX_UPLOAD_VIDEO_DURATION = float(os.environ.get("MAX_UPLOAD_VIDEO_DURATION", "600"))

# Max accepted upload size in bytes. The default is 1000 MiB.
MAX_UPLOAD_FILE_SIZE_BYTES = int(
    os.environ.get("MAX_UPLOAD_FILE_SIZE_BYTES", str(1000 * 1024 * 1024))
)

# If set, it will define which video is returned by the default video query for
# desktop
DEFAULT_VIDEO_PATH = os.getenv("DEFAULT_VIDEO_PATH")

# Prefix for gallery videos
GALLERY_PREFIX = "gallery"

# Path where all gallery videos are stored
GALLERY_PATH = DATA_PATH / GALLERY_PREFIX

# Prefix for uploaded videos
UPLOADS_PREFIX = "uploads"

# Path where all uploaded videos are stored
UPLOADS_PATH = DATA_PATH / UPLOADS_PREFIX

# Prefix for chunked upload sessions
UPLOAD_SESSIONS_PREFIX = "upload_sessions"

# Path where all chunked upload session state is stored
UPLOAD_SESSIONS_PATH = DATA_PATH / UPLOAD_SESSIONS_PREFIX

# Chunk size for REST upload sessions. The default is 8 MiB.
UPLOAD_CHUNK_SIZE_BYTES = int(
    os.getenv("UPLOAD_CHUNK_SIZE_BYTES", str(8 * 1024 * 1024))
)

# Prefix for video posters (1st frame of video)
POSTERS_PREFIX = "posters"

# Path where all posters are stored
POSTERS_PATH = DATA_PATH / POSTERS_PREFIX

# Make sure any of those paths exist
os.makedirs(DATA_PATH, exist_ok=True)
os.makedirs(GALLERY_PATH, exist_ok=True)
os.makedirs(UPLOADS_PATH, exist_ok=True)
os.makedirs(UPLOAD_SESSIONS_PATH, exist_ok=True)
os.makedirs(POSTERS_PATH, exist_ok=True)
