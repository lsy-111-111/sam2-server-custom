# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

from typing import Iterable, List, Optional

import strawberry
from app_conf import DATA_PATH, DEFAULT_VIDEO_PATH, MAX_UPLOAD_VIDEO_DURATION
from data.data_types import (
    AddPointsBatchInput,
    AddPointsInput,
    CancelPropagateInVideo,
    CancelPropagateInVideoInput,
    ClearPointsInFrameInput,
    ClearPointsInVideo,
    ClearPointsInVideoInput,
    CloseSession,
    CloseSessionInput,
    RemoveObjectInput,
    RLEMask,
    RLEMaskForObject,
    RLEMaskListOnFrame,
    StartSession,
    StartSessionInput,
    Video,
)
from data.store import get_videos
from data.video_processing import build_uploaded_video, process_video_upload
from inference.data_types import (
    AddPointsBatchItem,
    AddPointsBatchRequest,
    AddPointsRequest,
    CancelPropagateInVideoRequest,
    ClearPointsInFrameRequest,
    ClearPointsInVideoRequest,
    CloseSessionRequest,
    RemoveObjectRequest,
    StartSessionRequest,
)
from inference.predictor import InferenceAPI
from strawberry import relay
from strawberry.file_uploads import Upload


@strawberry.type
class Query:

    @strawberry.field
    def default_video(self) -> Video:
        """
        Return the default video.

        The default video can be set with the DEFAULT_VIDEO_PATH environment
        variable. It will return the video that matches this path. If no video
        is found, it will return the first video.
        """
        all_videos = get_videos()

        # Find the video that matches the default path and return that as
        # default video.
        for _, v in all_videos.items():
            if v.path == DEFAULT_VIDEO_PATH:
                return v

        # Fallback is returning the first video
        return next(iter(all_videos.values()))

    @relay.connection(relay.ListConnection[Video])
    def videos(
        self,
    ) -> Iterable[Video]:
        """
        Return all available videos.
        """
        all_videos = get_videos()
        return all_videos.values()


@strawberry.type
class Mutation:

    @strawberry.mutation
    def upload_video(
        self,
        file: Upload,
        start_time_sec: Optional[float] = None,
        duration_time_sec: Optional[float] = None,
    ) -> Video:
        """
        Receive a video file and process it through the shared upload pipeline.
        """
        filepath, file_key, video_metadata = process_video_upload(
            file,
            max_time=MAX_UPLOAD_VIDEO_DURATION,
            start_time_sec=start_time_sec,
            duration_time_sec=duration_time_sec,
        )
        return build_uploaded_video(filepath, file_key, video_metadata)

    @strawberry.mutation
    def start_session(
        self, input: StartSessionInput, info: strawberry.Info
    ) -> StartSession:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = StartSessionRequest(
            type="start_session",
            path=f"{DATA_PATH}/{input.path}",
        )

        response = inference_api.start_session(request=request)

        return StartSession(session_id=response.session_id)

    @strawberry.mutation
    def close_session(
        self, input: CloseSessionInput, info: strawberry.Info
    ) -> CloseSession:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = CloseSessionRequest(
            type="close_session",
            session_id=input.session_id,
        )
        response = inference_api.close_session(request)
        return CloseSession(success=response.success)

    @strawberry.mutation
    def add_points(
        self, input: AddPointsInput, info: strawberry.Info
    ) -> RLEMaskListOnFrame:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = AddPointsRequest(
            type="add_points",
            session_id=input.session_id,
            frame_index=input.frame_index,
            object_id=input.object_id,
            points=input.points,
            labels=input.labels,
            clear_old_points=input.clear_old_points,
        )
        reponse = inference_api.add_points(request)

        return RLEMaskListOnFrame(
            frame_index=reponse.frame_index,
            rle_mask_list=[
                RLEMaskForObject(
                    object_id=r.object_id,
                    rle_mask=RLEMask(counts=r.mask.counts, size=r.mask.size, order="F"),
                )
                for r in reponse.results
            ],
        )

    @strawberry.mutation
    def add_points_batch(
        self, input: AddPointsBatchInput, info: strawberry.Info
    ) -> RLEMaskListOnFrame:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = AddPointsBatchRequest(
            type="add_points_batch",
            session_id=input.session_id,
            frame_index=input.frame_index,
            clear_old_points=input.clear_old_points,
            objects=[
                AddPointsBatchItem(
                    object_id=item.object_id,
                    points=item.points,
                    labels=item.labels,
                )
                for item in input.objects
            ],
        )
        response = inference_api.add_points_batch(request)

        return RLEMaskListOnFrame(
            frame_index=response.frame_index,
            rle_mask_list=[
                RLEMaskForObject(
                    object_id=r.object_id,
                    rle_mask=RLEMask(counts=r.mask.counts, size=r.mask.size, order="F"),
                )
                for r in response.results
            ],
        )

    @strawberry.mutation
    def remove_object(
        self, input: RemoveObjectInput, info: strawberry.Info
    ) -> List[RLEMaskListOnFrame]:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = RemoveObjectRequest(
            type="remove_object", session_id=input.session_id, object_id=input.object_id
        )

        response = inference_api.remove_object(request)

        return [
            RLEMaskListOnFrame(
                frame_index=res.frame_index,
                rle_mask_list=[
                    RLEMaskForObject(
                        object_id=r.object_id,
                        rle_mask=RLEMask(
                            counts=r.mask.counts, size=r.mask.size, order="F"
                        ),
                    )
                    for r in res.results
                ],
            )
            for res in response.results
        ]

    @strawberry.mutation
    def clear_points_in_frame(
        self, input: ClearPointsInFrameInput, info: strawberry.Info
    ) -> RLEMaskListOnFrame:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = ClearPointsInFrameRequest(
            type="clear_points_in_frame",
            session_id=input.session_id,
            frame_index=input.frame_index,
            object_id=input.object_id,
        )

        response = inference_api.clear_points_in_frame(request)

        return RLEMaskListOnFrame(
            frame_index=response.frame_index,
            rle_mask_list=[
                RLEMaskForObject(
                    object_id=r.object_id,
                    rle_mask=RLEMask(counts=r.mask.counts, size=r.mask.size, order="F"),
                )
                for r in response.results
            ],
        )

    @strawberry.mutation
    def clear_points_in_video(
        self, input: ClearPointsInVideoInput, info: strawberry.Info
    ) -> ClearPointsInVideo:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = ClearPointsInVideoRequest(
            type="clear_points_in_video",
            session_id=input.session_id,
        )
        response = inference_api.clear_points_in_video(request)
        return ClearPointsInVideo(success=response.success)

    @strawberry.mutation
    def cancel_propagate_in_video(
        self, input: CancelPropagateInVideoInput, info: strawberry.Info
    ) -> CancelPropagateInVideo:
        inference_api: InferenceAPI = info.context["inference_api"]

        request = CancelPropagateInVideoRequest(
            type="cancel_propagate_in_video",
            session_id=input.session_id,
        )
        response = inference_api.cancel_propagate_in_video(request)
        return CancelPropagateInVideo(success=response.success)


schema = strawberry.Schema(
    query=Query,
    mutation=Mutation,
)