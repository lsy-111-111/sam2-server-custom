# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import contextlib
import gc
import logging
import os
import time
import uuid
from pathlib import Path
from threading import Event, Lock, RLock, Semaphore
from typing import Any, Dict, Generator, List

import numpy as np
import torch
from app_conf import APP_ROOT, MODEL_SIZE
from data.transcoder import get_video_metadata
from inference.data_types import (
    AddMaskRequest,
    AddPointsBatchRequest,
    AddPointsRequest,
    CancelPorpagateResponse,
    CancelPropagateInVideoRequest,
    ClearPointsInFrameRequest,
    ClearPointsInVideoRequest,
    ClearPointsInVideoResponse,
    CloseSessionRequest,
    CloseSessionResponse,
    Mask,
    PropagateDataResponse,
    PropagateDataValue,
    PropagateInVideoRequest,
    RemoveObjectRequest,
    RemoveObjectResponse,
    StartSessionRequest,
    StartSessionResponse,
)
from pycocotools.mask import decode as decode_masks, encode as encode_masks
from sam2.build_sam import build_sam2_video_predictor


logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)
LONG_VIDEO_OFFLOAD_THRESHOLD_SECONDS = 180.0


class PropagationQueueFullError(RuntimeError):
    pass


class PropagationBusyError(RuntimeError):
    pass


def _get_bool_env(name: str, default: bool) -> bool:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default

    normalized = raw_value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False

    logger.warning(f"invalid {name}={raw_value!r}; using default {default}")
    return default


def _get_non_negative_int_env(name: str, default: int) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default

    try:
        value = int(raw_value)
    except ValueError:
        logger.warning(f"invalid {name}={raw_value!r}; using default {default}")
        return default

    return max(value, 0)


def _get_non_negative_float_env(name: str, default: float) -> float:
    raw_value = os.environ.get(name)
    if raw_value is None:
        return default

    try:
        value = float(raw_value)
    except ValueError:
        logger.warning(f"invalid {name}={raw_value!r}; using default {default}")
        return default

    return max(value, 0.0)


class InferenceAPI:

    def __init__(self) -> None:
        super(InferenceAPI, self).__init__()

        self.session_states: Dict[str, Any] = {}
        self.session_lock = RLock()
        self.score_thresh = 0
        self.session_ttl_seconds = _get_non_negative_int_env(
            "SAM2_DEMO_SESSION_TTL_SECONDS", 900
        )
        self.max_sessions = _get_non_negative_int_env("SAM2_DEMO_MAX_SESSIONS", 2)
        self.propagate_queue_size = _get_non_negative_int_env(
            "SAM2_DEMO_PROPAGATE_QUEUE_SIZE", 8
        )
        self.propagate_max_seconds = _get_non_negative_float_env(
            "SAM2_DEMO_PROPAGATE_MAX_SECONDS", 300.0
        )
        self.propagate_queue_poll_seconds = max(
            _get_non_negative_float_env("SAM2_DEMO_PROPAGATE_QUEUE_POLL_SECONDS", 0.5),
            0.1,
        )

        if MODEL_SIZE == "tiny":
            checkpoint = Path(APP_ROOT) / "checkpoints/sam2.1_hiera_tiny.pt"
            model_cfg = "configs/sam2.1/sam2.1_hiera_t.yaml"
        elif MODEL_SIZE == "small":
            checkpoint = Path(APP_ROOT) / "checkpoints/sam2.1_hiera_small.pt"
            model_cfg = "configs/sam2.1/sam2.1_hiera_s.yaml"
        elif MODEL_SIZE == "large":
            checkpoint = Path(APP_ROOT) / "checkpoints/sam2.1_hiera_large.pt"
            model_cfg = "configs/sam2.1/sam2.1_hiera_l.yaml"
        else:  # base_plus (default)
            checkpoint = Path(APP_ROOT) / "checkpoints/sam2.1_hiera_base_plus.pt"
            model_cfg = "configs/sam2.1/sam2.1_hiera_b+.yaml"

        # select the device for computation
        force_cpu_device = os.environ.get("SAM2_DEMO_FORCE_CPU_DEVICE", "0") == "1"
        if force_cpu_device:
            logger.info("forcing CPU device for SAM 2 demo")
        if not force_cpu_device and torch.cuda.is_available():
            device = torch.device("cuda")
        elif not force_cpu_device and torch.backends.mps.is_available():
            device = torch.device("mps")
        else:
            device = torch.device("cpu")
        logger.info(f"using device: {device}")

        if device.type == "cuda":
            # turn on tfloat32 for Ampere GPUs (https://pytorch.org/docs/stable/notes/cuda.html#tensorfloat-32-tf32-on-ampere-devices)
            if torch.cuda.get_device_properties(0).major >= 8:
                torch.backends.cuda.matmul.allow_tf32 = True
                torch.backends.cudnn.allow_tf32 = True
        elif device.type == "mps":
            logging.warning(
                "\nSupport for MPS devices is preliminary. SAM 2 is trained with CUDA and might "
                "give numerically different outputs and sometimes degraded performance on MPS. "
                "See e.g. https://github.com/pytorch/pytorch/issues/84936 for a discussion."
            )

        self.device = device
        self.long_video_offload_threshold_seconds = _get_non_negative_float_env(
            "SAM2_DEMO_LONG_VIDEO_OFFLOAD_THRESHOLD_SECONDS",
            LONG_VIDEO_OFFLOAD_THRESHOLD_SECONDS,
        )
        self.enable_hybrid_frame_cache = _get_bool_env(
            "SAM2_DEMO_ENABLE_HYBRID_FRAME_CACHE", False
        )
        self.gpu_admission_budget_gb = _get_non_negative_float_env(
            "SAM2_DEMO_GPU_ADMISSION_BUDGET_GB", 28.0
        )
        self.gpu_high_watermark_gb = _get_non_negative_float_env(
            "SAM2_DEMO_GPU_HIGH_WATERMARK_GB", 34.0
        )
        self.gpu_low_watermark_gb = _get_non_negative_float_env(
            "SAM2_DEMO_GPU_LOW_WATERMARK_GB", 30.0
        )
        self.prefetch_ahead_frames = _get_non_negative_int_env(
            "SAM2_DEMO_PREFETCH_AHEAD_FRAMES", 32
        )
        self.retain_behind_frames = _get_non_negative_int_env(
            "SAM2_DEMO_RETAIN_BEHIND_FRAMES", 8
        )
        self.enable_multi_obj_batch = _get_bool_env(
            "SAM2_DEMO_ENABLE_MULTI_OBJ_BATCH", True
        )
        self.multi_obj_batch_min_objs = max(
            _get_non_negative_int_env("SAM2_DEMO_MULTI_OBJ_BATCH_MIN_OBJS", 2), 1
        )
        self.multi_obj_batch_max_objs = max(
            _get_non_negative_int_env("SAM2_DEMO_MULTI_OBJ_BATCH_MAX_OBJS", 4),
            self.multi_obj_batch_min_objs,
        )
        self.add_points_batch_max_objs = max(
            _get_non_negative_int_env("SAM2_DEMO_ADD_POINTS_BATCH_MAX_OBJS", 8),
            1,
        )
        self.predictor = build_sam2_video_predictor(
            model_cfg, checkpoint, device=device
        )
        self.inference_lock = Lock()
        self.propagate_slots = Semaphore(self.propagate_queue_size + 1)
        self.propagate_runner = Semaphore(1)

    def autocast_context(self):
        if self.device.type == "cuda":
            return torch.autocast("cuda", dtype=torch.bfloat16)
        else:
            return contextlib.nullcontext()

    def __get_video_duration_sec(self, path: str) -> float | None:
        try:
            metadata = get_video_metadata(path)
        except Exception:
            logger.exception(f"failed to inspect processed video metadata for {path}")
            return None
        return metadata.duration_sec

    def __get_cuda_reserved_memory_gb(self) -> float:
        if self.device.type != "cuda" or not torch.cuda.is_available():
            return 0.0
        return torch.cuda.memory_reserved(self.device) / 1024**3

    def __get_session_runtime_config(
        self, video_duration_sec: float | None
    ) -> dict[str, Any]:
        is_long_processed_video = (
            video_duration_sec is not None
            and video_duration_sec > self.long_video_offload_threshold_seconds
        )
        reserved_memory_gb = self.__get_cuda_reserved_memory_gb()

        config: dict[str, Any] = {
            "is_long_processed_video": is_long_processed_video,
            "reserved_memory_gb": reserved_memory_gb,
            "offload_video_to_cpu": False,
            "offload_state_to_cpu": False,
            "hybrid_frame_cache_settings": None,
            "runtime_memory_settings": None,
            "strategy": "default_gpu",
        }

        if self.device.type == "mps":
            config["offload_video_to_cpu"] = True
            config["offload_state_to_cpu"] = True
            config["strategy"] = "mps_cpu_offload"
            return config

        if self.device.type != "cuda" or not is_long_processed_video:
            return config

        if not self.enable_hybrid_frame_cache:
            config["offload_video_to_cpu"] = True
            config["offload_state_to_cpu"] = True
            config["strategy"] = "long_video_cpu_offload"
            return config

        if reserved_memory_gb >= self.gpu_admission_budget_gb:
            config["offload_video_to_cpu"] = True
            config["offload_state_to_cpu"] = True
            config["strategy"] = "long_video_cpu_offload_admission"
            return config

        low_watermark_gb = min(
            self.gpu_low_watermark_gb, self.gpu_high_watermark_gb
        )
        config["hybrid_frame_cache_settings"] = {
            "gpu_high_watermark_gb": self.gpu_high_watermark_gb,
            "gpu_low_watermark_gb": low_watermark_gb,
            "prefetch_ahead_frames": self.prefetch_ahead_frames,
            "retain_behind_frames": self.retain_behind_frames,
        }
        config["runtime_memory_settings"] = {
            "high_watermark_gb": self.gpu_high_watermark_gb,
            "low_watermark_gb": low_watermark_gb,
        }
        config["strategy"] = "long_video_gpu_first_hybrid"
        return config

    def start_session(self, request: StartSessionRequest) -> StartSessionResponse:
        with self.autocast_context(), self.inference_lock:
            with self.session_lock:
                self.__collect_expired_sessions()
                self.__ensure_session_capacity()

            session_id = str(uuid.uuid4())
            video_duration_sec = self.__get_video_duration_sec(request.path)
            runtime_config = self.__get_session_runtime_config(video_duration_sec)
            offload_video_to_cpu = runtime_config["offload_video_to_cpu"]
            offload_state_to_cpu = runtime_config["offload_state_to_cpu"]
            inference_state = self.predictor.init_state(
                request.path,
                offload_video_to_cpu=offload_video_to_cpu,
                offload_state_to_cpu=offload_state_to_cpu,
                hybrid_frame_cache_settings=runtime_config[
                    "hybrid_frame_cache_settings"
                ],
                runtime_memory_settings=runtime_config["runtime_memory_settings"],
                multi_obj_batch_settings={
                    "enabled": self.enable_multi_obj_batch,
                    "min_objs": self.multi_obj_batch_min_objs,
                    "max_objs": self.multi_obj_batch_max_objs,
                    "add_points_max_objs": self.add_points_batch_max_objs,
                },
            )
            now = time.time()
            with self.session_lock:
                self.session_states[session_id] = {
                    "active_propagations": 0,
                    "cancel_event": Event(),
                    "canceled": False,
                    "created_at": now,
                    "last_accessed_at": now,
                    "propagation_status": "idle",
                    "queued_propagations": 0,
                    "state": inference_state,
                }
            logger.info(
                f"started session {session_id} for {request.path}; "
                f"duration_sec={video_duration_sec}; "
                f"strategy={runtime_config['strategy']}; "
                f"reserved_memory_gb={runtime_config['reserved_memory_gb']:.2f}; "
                f"is_long_processed_video={runtime_config['is_long_processed_video']}; "
                f"offload_video_to_cpu={offload_video_to_cpu}; "
                f"offload_state_to_cpu={offload_state_to_cpu}; "
                f"hybrid_frame_cache={runtime_config['hybrid_frame_cache_settings'] is not None}; "
                f"multi_obj_batch={self.enable_multi_obj_batch}; "
                f"{self.__get_session_stats()}"
            )
            return StartSessionResponse(session_id=session_id)

    def close_session(self, request: CloseSessionRequest) -> CloseSessionResponse:
        self.__request_cancel_session(request.session_id, reason="close_session")
        with self.inference_lock:
            is_successful = self.__clear_session_state(
                request.session_id, reason="client_request"
            )
        return CloseSessionResponse(success=is_successful)

    def add_points(
        self, request: AddPointsRequest, test: str = ""
    ) -> PropagateDataResponse:
        with self.autocast_context(), self.inference_lock:
            session = self.__get_session(request.session_id)
            inference_state = session["state"]

            frame_idx = request.frame_index
            obj_id = request.object_id
            points = request.points
            labels = request.labels
            clear_old_points = request.clear_old_points

            # add new prompts and instantly get the output on the same frame
            frame_idx, object_ids, masks = self.predictor.add_new_points_or_box(
                inference_state=inference_state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                points=points,
                labels=labels,
                clear_old_points=clear_old_points,
                normalize_coords=False,
            )

            masks_binary = (masks > self.score_thresh)[:, 0].cpu().numpy()

            rle_mask_list = self.__get_rle_mask_list(
                object_ids=object_ids, masks=masks_binary
            )

            return PropagateDataResponse(
                frame_index=frame_idx,
                results=rle_mask_list,
            )

    def add_points_batch(
        self, request: AddPointsBatchRequest
    ) -> PropagateDataResponse:
        if len(request.objects) == 0:
            raise ValueError("add_points_batch requires at least one object")

        seen_object_ids = set()
        for item in request.objects:
            if item.object_id in seen_object_ids:
                raise ValueError(f"duplicate object id in add_points_batch: {item.object_id}")
            seen_object_ids.add(item.object_id)
            if len(item.points) == 0:
                raise ValueError("add_points_batch does not accept empty point lists")
            if len(item.points) != len(item.labels):
                raise ValueError(
                    f"points and labels length mismatch for object {item.object_id}"
                )

        with self.autocast_context(), self.inference_lock:
            session = self.__get_session(request.session_id)
            inference_state = session["state"]

            frame_idx, object_ids, masks = self.predictor.add_new_points_or_box_batch(
                inference_state=inference_state,
                frame_idx=request.frame_index,
                objects=[
                    {
                        "obj_id": item.object_id,
                        "points": item.points,
                        "labels": item.labels,
                    }
                    for item in request.objects
                ],
                clear_old_points=request.clear_old_points,
                normalize_coords=False,
            )

            masks_binary = (masks > self.score_thresh)[:, 0].cpu().numpy()
            rle_mask_list = self.__get_rle_mask_list(
                object_ids=object_ids, masks=masks_binary
            )

            return PropagateDataResponse(
                frame_index=frame_idx,
                results=rle_mask_list,
            )

    def add_mask(self, request: AddMaskRequest) -> PropagateDataResponse:
        """
        Add new points on a specific video frame.
        - mask is a numpy array of shape [H_im, W_im] (containing 1 for foreground and 0 for background).
        Note: providing an input mask would overwrite any previous input points on this frame.
        """
        with self.autocast_context(), self.inference_lock:
            session_id = request.session_id
            frame_idx = request.frame_index
            obj_id = request.object_id
            rle_mask = {
                "counts": request.mask.counts,
                "size": request.mask.size,
            }

            mask = decode_masks(rle_mask)

            logger.info(
                f"add mask on frame {frame_idx} in session {session_id}: {obj_id=}, {mask.shape=}"
            )
            session = self.__get_session(session_id)
            inference_state = session["state"]

            frame_idx, obj_ids, video_res_masks = self.model.add_new_mask(
                inference_state=inference_state,
                frame_idx=frame_idx,
                obj_id=obj_id,
                mask=torch.tensor(mask > 0),
            )
            masks_binary = (video_res_masks > self.score_thresh)[:, 0].cpu().numpy()

            rle_mask_list = self.__get_rle_mask_list(
                object_ids=obj_ids, masks=masks_binary
            )

            return PropagateDataResponse(
                frame_index=frame_idx,
                results=rle_mask_list,
            )

    def clear_points_in_frame(
        self, request: ClearPointsInFrameRequest
    ) -> PropagateDataResponse:
        """
        Remove all input points in a specific frame.
        """
        with self.autocast_context(), self.inference_lock:
            session_id = request.session_id
            frame_idx = request.frame_index
            obj_id = request.object_id

            logger.info(
                f"clear inputs on frame {frame_idx} in session {session_id}: {obj_id=}"
            )
            session = self.__get_session(session_id)
            inference_state = session["state"]
            frame_idx, obj_ids, video_res_masks = (
                self.predictor.clear_all_prompts_in_frame(
                    inference_state, frame_idx, obj_id
                )
            )
            masks_binary = (video_res_masks > self.score_thresh)[:, 0].cpu().numpy()

            rle_mask_list = self.__get_rle_mask_list(
                object_ids=obj_ids, masks=masks_binary
            )

            return PropagateDataResponse(
                frame_index=frame_idx,
                results=rle_mask_list,
            )

    def clear_points_in_video(
        self, request: ClearPointsInVideoRequest
    ) -> ClearPointsInVideoResponse:
        """
        Remove all input points in all frames throughout the video.
        """
        with self.autocast_context(), self.inference_lock:
            session_id = request.session_id
            logger.info(f"clear all inputs across the video in session {session_id}")
            session = self.__get_session(session_id)
            inference_state = session["state"]
            self.predictor.reset_state(inference_state)
            return ClearPointsInVideoResponse(success=True)

    def remove_object(self, request: RemoveObjectRequest) -> RemoveObjectResponse:
        """
        Remove an object id from the tracking state.
        """
        with self.autocast_context(), self.inference_lock:
            session_id = request.session_id
            obj_id = request.object_id
            logger.info(f"remove object in session {session_id}: {obj_id=}")
            session = self.__get_session(session_id)
            inference_state = session["state"]
            new_obj_ids, updated_frames = self.predictor.remove_object(
                inference_state, obj_id
            )

            results = []
            for frame_index, video_res_masks in updated_frames:
                masks = (video_res_masks > self.score_thresh)[:, 0].cpu().numpy()
                rle_mask_list = self.__get_rle_mask_list(
                    object_ids=new_obj_ids, masks=masks
                )
                results.append(
                    PropagateDataResponse(
                        frame_index=frame_index,
                        results=rle_mask_list,
                    )
                )

            return RemoveObjectResponse(results=results)

    def propagate_in_video(
        self, request: PropagateInVideoRequest
    ) -> Generator[PropagateDataResponse, None, None]:
        session_id = request.session_id
        if not self.propagate_slots.acquire(blocking=False):
            raise PropagationQueueFullError(
                "propagation queue is full; try again after current tracking requests finish"
            )
        try:
            with self.session_lock:
                session = self.session_states.get(session_id)
                if session is None:
                    raise RuntimeError(f"Cannot find session {session_id}; it might have expired")
                if session.get("queued_propagations", 0) > 0 or session.get("active_propagations", 0) > 0:
                    raise PropagationBusyError(f"session {session_id} already has a propagation request")
                cancel_event = session.get("cancel_event")
                if cancel_event is None:
                    cancel_event = Event()
                    session["cancel_event"] = cancel_event
                cancel_event.clear()
                session["canceled"] = False
                session["queued_propagations"] = 1
                session["propagation_status"] = "queued"
                self.__touch_session(session)
            return self.__propagate_in_video_stream(request, cancel_event)
        except Exception:
            with self.session_lock:
                session = self.session_states.get(session_id)
                if session is not None:
                    session["queued_propagations"] = 0
                    session["propagation_status"] = "idle"
            self.propagate_slots.release()
            raise

    def __propagate_in_video_stream(
        self, request: PropagateInVideoRequest, cancel_event: Event
    ) -> Generator[PropagateDataResponse, None, None]:
        session_id = request.session_id
        start_frame_idx = request.start_frame_index
        trim_start_frame = request.trim_start_frame
        trim_end_frame_exclusive = request.trim_end_frame_exclusive
        queued_at = time.perf_counter()
        run_started_at = None
        yielded_frames = 0
        inference_state = None
        runner_acquired = False
        end_reason = "unknown"

        try:
            while not self.propagate_runner.acquire(timeout=self.propagate_queue_poll_seconds):
                if cancel_event.is_set():
                    end_reason = "canceled_while_queued"
                    return

            runner_acquired = True
            run_started_at = time.perf_counter()
            with self.session_lock:
                session = self.session_states.get(session_id)
                if session is None:
                    end_reason = "missing_session"
                    raise RuntimeError(f"Cannot find session {session_id}; it might have expired")
                session["queued_propagations"] = 0
                session["active_propagations"] = session.get("active_propagations", 0) + 1
                session["propagation_status"] = "running"
                self.__touch_session(session)

            with self.autocast_context(), self.inference_lock:
                logger.info(
                    f"propagate in video in session {session_id}: start_frame_idx={start_frame_idx}, "
                    f"queued_seconds={run_started_at - queued_at:.3f}"
                )
                session = self.__get_session(session_id)
                inference_state = session["state"]
                num_frames = int(inference_state.get("num_frames", 1))
                trim_start_idx = max(0, min(int(trim_start_frame or 0), num_frames - 1))
                requested_trim_end = num_frames if trim_end_frame_exclusive is None else int(trim_end_frame_exclusive)
                trim_end_idx_exclusive = max(trim_start_idx + 1, min(requested_trim_end, num_frames))
                start_frame_idx = max(trim_start_idx, min(int(start_frame_idx), trim_end_idx_exclusive - 1))
                forward_max = max(0, trim_end_idx_exclusive - start_frame_idx - 1)
                backward_max = max(0, start_frame_idx - trim_start_idx)
                logger.info(
                    f"trim range in session {session_id}: trim_start_idx={trim_start_idx}, "
                    f"trim_end_idx_exclusive={trim_end_idx_exclusive}, clamped_start_frame_idx={start_frame_idx}"
                )

                def should_stop() -> bool:
                    nonlocal end_reason
                    if cancel_event.is_set() or session.get("canceled", False):
                        end_reason = "canceled"
                        return True
                    if self.propagate_max_seconds > 0 and run_started_at is not None:
                        if time.perf_counter() - run_started_at > self.propagate_max_seconds:
                            end_reason = "timed_out"
                            logger.warning(
                                f"propagation timed out in session {session_id}; max_seconds={self.propagate_max_seconds}"
                            )
                            return True
                    return False

                for reverse, max_frames in ((False, forward_max), (True, backward_max)):
                    for frame_idx, obj_ids, video_res_masks in self.predictor.propagate_in_video(
                        inference_state=inference_state,
                        start_frame_idx=start_frame_idx,
                        max_frame_num_to_track=max_frames,
                        reverse=reverse,
                    ):
                        if should_stop():
                            return
                        masks_binary = (video_res_masks > self.score_thresh)[:, 0].cpu().numpy()
                        yielded_frames += 1
                        yield PropagateDataResponse(
                            frame_index=frame_idx,
                            results=self.__get_rle_mask_list(object_ids=obj_ids, masks=masks_binary),
                        )
                end_reason = "completed"
        except GeneratorExit:
            end_reason = "client_disconnected"
            cancel_event.set()
            raise
        finally:
            elapsed = time.perf_counter() - run_started_at if run_started_at is not None else 0.0
            with self.session_lock:
                session = self.session_states.get(session_id)
                if session is not None:
                    session["queued_propagations"] = 0
                    session["active_propagations"] = max(0, session.get("active_propagations", 0) - (1 if runner_acquired else 0))
                    session["propagation_status"] = end_reason
            if runner_acquired:
                self.propagate_runner.release()
            self.propagate_slots.release()
            runtime_stats = inference_state.get("runtime_stats", {}) if inference_state is not None else {}
            frame_cache = inference_state.get("hybrid_frame_cache") if inference_state is not None else None
            frame_cache_stats = frame_cache.get_stats() if frame_cache is not None else None
            logger.info(
                f"propagation ended in session {session_id}; reason={end_reason}; "
                f"yielded_frames={yielded_frames}; queued_seconds={(run_started_at - queued_at) if run_started_at is not None else 0.0:.3f}; "
                f"elapsed_seconds={elapsed:.3f}; fps={(yielded_frames / elapsed) if elapsed > 0 else 0.0:.2f}; "
                f"runtime_stats={runtime_stats}; frame_cache_stats={frame_cache_stats}; {self.__get_session_stats()}"
            )

    def cancel_propagate_in_video(
        self, request: CancelPropagateInVideoRequest
    ) -> CancelPorpagateResponse:
        return CancelPorpagateResponse(
            success=self.__request_cancel_session(
                request.session_id, reason="cancel_propagate"
            )
        )

    def __get_rle_mask_list(
        self, object_ids: List[int], masks: np.ndarray
    ) -> List[PropagateDataValue]:
        """
        Return a list of data values, i.e. list of object/mask combos.
        """
        return [
            self.__get_mask_for_object(object_id=object_id, mask=mask)
            for object_id, mask in zip(object_ids, masks)
        ]

    def __get_mask_for_object(
        self, object_id: int, mask: np.ndarray
    ) -> PropagateDataValue:
        """
        Create a data value for an object/mask combo.
        """
        mask_rle = encode_masks(np.array(mask, dtype=np.uint8, order="F"))
        mask_rle["counts"] = mask_rle["counts"].decode()
        return PropagateDataValue(
            object_id=object_id,
            mask=Mask(
                size=mask_rle["size"],
                counts=mask_rle["counts"],
            ),
        )

    def __touch_session(self, session: Dict[str, Any]) -> None:
        session["last_accessed_at"] = time.time()

    def __collect_expired_sessions(self) -> None:
        if self.session_ttl_seconds <= 0 or len(self.session_states) == 0:
            return

        now = time.time()
        expired_session_ids = []
        for session_id, session in list(self.session_states.items()):
            last_accessed_at = session.get(
                "last_accessed_at", session.get("created_at", now)
            )
            if now - last_accessed_at > self.session_ttl_seconds:
                expired_session_ids.append(session_id)

        for session_id in expired_session_ids:
            self.__clear_session_state(
                session_id, reason=f"idle_timeout>{self.session_ttl_seconds}s"
            )

    def __ensure_session_capacity(self) -> None:
        if self.max_sessions <= 0:
            return
        while len(self.session_states) >= self.max_sessions:
            inactive = [
                (session_id, session)
                for session_id, session in self.session_states.items()
                if session.get("active_propagations", 0) == 0
                and session.get("queued_propagations", 0) == 0
            ]
            if len(inactive) == 0:
                raise RuntimeError(
                    "maximum SAM2 sessions reached and all sessions are active; close an existing session first"
                )
            oldest_session_id = min(
                inactive,
                key=lambda item: item[1].get("last_accessed_at", item[1].get("created_at", 0.0)),
            )[0]
            self.__clear_session_state(
                oldest_session_id, reason=f"capacity_limit={self.max_sessions}"
            )

    def __request_cancel_session(self, session_id: str, reason: str) -> bool:
        with self.session_lock:
            session = self.session_states.get(session_id)
            if session is None:
                logger.warning(
                    f"cannot cancel propagation for session {session_id}; reason={reason}; session not found"
                )
                return False
            session["canceled"] = True
            cancel_event = session.get("cancel_event")
            if cancel_event is not None:
                cancel_event.set()
            session["propagation_status"] = f"cancel_requested:{reason}"
            self.__touch_session(session)
            logger.info(
                f"cancel requested for session {session_id}; reason={reason}; {self.__get_session_stats()}"
            )
            return True

    def __release_session_state(self, session_id: str, session: Dict[str, Any]) -> None:
        inference_state = session.get("state")
        if inference_state is None:
            return

        try:
            self.predictor.reset_state(inference_state)
        except Exception:
            logger.exception(
                f"failed to reset predictor state while removing session {session_id}"
            )

        try:
            inference_state.clear()
        except Exception:
            logger.exception(
                f"failed to clear inference state while removing session {session_id}"
            )

        session["state"] = None
        gc.collect()

        if self.device.type == "cuda" and torch.cuda.is_available():
            torch.cuda.empty_cache()
            if hasattr(torch.cuda, "ipc_collect"):
                torch.cuda.ipc_collect()

    def __get_session(self, session_id: str):
        with self.session_lock:
            self.__collect_expired_sessions()
            session = self.session_states.get(session_id, None)
            if session is None:
                raise RuntimeError(f"Cannot find session {session_id}; it might have expired")
            self.__touch_session(session)
            return session

    def __get_session_stats(self):
        """Get a statistics string for live sessions and their GPU usage."""
        with self.session_lock:
            live_session_strs = [
                f"'{session_id}' ({session['state']['num_frames']} frames, "
                f"{len(session['state']['obj_ids'])} objects, "
                f"status={session.get('propagation_status', 'idle')})"
                for session_id, session in self.session_states.items()
                if session.get("state") is not None
            ]
            live_count = len(self.session_states)
        if self.device.type == "cuda" and torch.cuda.is_available():
            memory_stats = (
                f"GPU memory: {torch.cuda.memory_allocated() // 1024**2} MiB used and "
                f"{torch.cuda.memory_reserved() // 1024**2} MiB reserved"
                f" (max over time: {torch.cuda.max_memory_allocated() // 1024**2} MiB used "
                f"and {torch.cuda.max_memory_reserved() // 1024**2} MiB reserved)"
            )
        else:
            memory_stats = f"device={self.device.type}"
        return f"live sessions ({live_count}): [{', '.join(live_session_strs)}], {memory_stats}"

    def __clear_session_state(
        self, session_id: str, reason: str = "client_request"
    ) -> bool:
        with self.session_lock:
            session = self.session_states.pop(session_id, None)
        if session is None:
            logger.warning(
                f"cannot close session {session_id} as it does not exist (it might have expired); "
                f"reason={reason}; {self.__get_session_stats()}"
            )
            return False
        cancel_event = session.get("cancel_event")
        if cancel_event is not None:
            cancel_event.set()
        self.__release_session_state(session_id, session)
        logger.info(f"removed session {session_id}; reason={reason}; {self.__get_session_stats()}")
        return True
