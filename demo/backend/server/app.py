# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
# This source code is licensed under the license found in the
# LICENSE file in the root directory of this source tree.

import logging
import time
from typing import Any, Generator

from app_conf import (
    GALLERY_PATH,
    GALLERY_PREFIX,
    POSTERS_PATH,
    POSTERS_PREFIX,
    UPLOADS_PATH,
    UPLOADS_PREFIX,
)
from data.loader import preload_data
from data.schema import schema
from data.store import set_videos
from data.uploads import (
    UploadError,
    complete_upload,
    create_upload_session,
    delete_upload_session,
    export_annotations_archive_file,
    export_annotations_file,
    export_remainder_video,
    get_upload_session,
    get_upload_source_path,
    import_server_video,
    list_server_files,
    write_upload_chunk,
)
from flask import (
    Flask,
    Request,
    Response,
    jsonify,
    make_response,
    request,
    send_file,
    send_from_directory,
)
from flask_cors import CORS
from inference.data_types import PropagateInVideoRequest
from inference.multipart import MultipartResponseBuilder
from inference.predictor import (
    InferenceAPI,
    PropagationBusyError,
    PropagationQueueFullError,
)
from strawberry.flask.views import GraphQLView

logger = logging.getLogger(__name__)

app = Flask(__name__)
logger = app.logger
logger.setLevel(logging.INFO)
cors = CORS(app, supports_credentials=True)

videos = preload_data()
set_videos(videos)

inference_api = InferenceAPI()


def _client_ip() -> str:
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.remote_addr or "unknown"


@app.before_request
def _log_request_start() -> None:
    request._start_time = time.perf_counter()  # type: ignore[attr-defined]
    if request.path.startswith("/api/"):
        logger.info(
            "[REQ] %s %s from %s",
            request.method,
            request.full_path.rstrip("?"),
            _client_ip(),
        )


@app.after_request
def _log_request_end(response: Response) -> Response:
    if request.path.startswith("/api/"):
        start = getattr(request, "_start_time", None)
        duration = (
            f"{round((time.perf_counter() - start) * 1000)}ms"
            if start is not None
            else "?"
        )
        logger.info(
            "[RES] %s %s -> %s (%s)",
            request.method,
            request.full_path.rstrip("?"),
            response.status_code,
            duration,
        )
    return response


@app.route("/healthy")
def healthy() -> Response:
    return make_response("OK", 200)


@app.route(f"/{GALLERY_PREFIX}/<path:path>", methods=["GET"])
def send_gallery_video(path: str) -> Response:
    try:
        return send_from_directory(
            GALLERY_PATH,
            path,
        )
    except Exception as error:
        raise ValueError("resource not found") from error


@app.route(f"/{POSTERS_PREFIX}/<path:path>", methods=["GET"])
def send_poster_image(path: str) -> Response:
    try:
        return send_from_directory(
            POSTERS_PATH,
            path,
        )
    except Exception as error:
        raise ValueError("resource not found") from error


@app.route(f"/{UPLOADS_PREFIX}/<path:path>", methods=["GET"])
def send_uploaded_video(path: str) -> Response:
    try:
        return send_from_directory(
            UPLOADS_PATH,
            path,
        )
    except Exception as error:
        raise ValueError("resource not found") from error


# TODO: Protect route with ToS permission check
@app.route("/propagate_in_video", methods=["POST"])
def propagate_in_video() -> Response:
    data = request.json
    args = {
        "session_id": data["session_id"],
        "start_frame_index": data.get("start_frame_index", 0),
        "trim_start_frame": data.get("trim_start_frame"),
        "trim_end_frame_exclusive": data.get("trim_end_frame_exclusive"),
    }

    boundary = "frame"
    try:
        stream = inference_api.propagate_in_video(
            PropagateInVideoRequest(type="propagate_in_video", **args)
        )
    except PropagationQueueFullError as error:
        logger.warning("propagation queue full: %s", error)
        return jsonify({"error": str(error), "code": "propagation_queue_full"}), 429
    except PropagationBusyError as error:
        logger.warning("propagation busy: %s", error)
        return jsonify({"error": str(error), "code": "propagation_busy"}), 409
    except Exception as error:
        logger.exception("failed to start propagation stream")
        return jsonify({"error": str(error), "code": "propagation_start_failed"}), 500

    frame = gen_track_with_mask_stream(boundary, stream)
    return Response(frame, mimetype="multipart/x-savi-stream; boundary=" + boundary)


@app.route("/api/uploads", methods=["POST"])
def create_upload() -> Response:
    payload = request.get_json(silent=True) or {}
    try:
        result = create_upload_session(
            filename=str(payload.get("filename") or ""),
            size_bytes=int(payload.get("sizeBytes") or 0),
            content_type=str(payload.get("contentType") or ""),
        )
        return jsonify(result), 201
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to create upload session")
        return _json_error(
            UploadError(str(error) or "Failed to create upload session", 500)
        )


@app.route("/api/server-files", methods=["GET"])
def browse_server_files() -> Response:
    try:
        return jsonify(list_server_files(request.args.get("path")))
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to browse server files")
        return _json_error(
            UploadError(str(error) or "Failed to browse server files", 500)
        )


@app.route("/api/annotations/export", methods=["POST"])
def export_annotations() -> Response:
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify(
            export_annotations_file(
                str(payload.get("directoryPath") or ""),
                payload.get("payload"),
                video_path_value=payload.get("videoPath"),
                upload_id_value=payload.get("uploadId"),
            )
        ), 201
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to export annotations")
        return _json_error(
            UploadError(str(error) or "Failed to export annotations", 500)
        )




@app.route("/api/annotations/export/archive", methods=["POST"])
def export_annotations_archive() -> Response:
    payload = request.get_json(silent=True) or {}
    try:
        archive = export_annotations_archive_file(
            payload.get("payload"),
            video_path_value=payload.get("videoPath"),
            upload_id_value=payload.get("uploadId"),
        )
        response = make_response(archive["bytes"], 201)
        response.headers["Content-Type"] = "application/zip"
        response.headers["Content-Disposition"] = (
            f'attachment; filename="{archive["fileName"]}"'
        )
        response.headers["X-SAM2-Export-Dir"] = archive["exportDir"]
        return response
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to export annotation archive")
        return _json_error(
            UploadError(str(error) or "Failed to export annotation archive", 500)
        )


@app.route("/api/videos/remainder", methods=["POST"])
def create_remainder_video() -> Response:
    payload = request.get_json(silent=True) or {}
    try:
        return jsonify(
            export_remainder_video(
                video_path_value=payload.get("videoPath"),
                upload_id_value=payload.get("uploadId"),
                trim_end_frame_exclusive_value=payload.get("trimEndFrameExclusive"),
                total_frames_value=payload.get("totalFrames"),
            )
        )
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to prepare remaining video segment")
        return _json_error(
            UploadError(str(error) or "Failed to prepare remaining video segment", 500)
        )


@app.route("/api/uploads/import", methods=["POST"])
def import_upload() -> Response:
    payload = request.get_json(silent=True) or {}
    path_value = str(payload.get("path") or "")
    started_at = time.perf_counter()
    try:
        result = import_server_video(path_value)
        duration_ms = round((time.perf_counter() - started_at) * 1000)
        logger.info(
            "Imported server video path=%r upload_id=%s duration_ms=%s",
            path_value,
            result.get("uploadId"),
            duration_ms,
        )
        return jsonify(result), 201
    except UploadError as error:
        duration_ms = round((time.perf_counter() - started_at) * 1000)
        logger.warning(
            "Failed to import server video path=%r status=%s duration_ms=%s error=%s",
            path_value,
            error.status_code,
            duration_ms,
            error,
        )
        return _json_error(error, path=path_value, phase="import_server_video")
    except Exception as error:
        logger.exception("Failed to import server video path=%r", path_value)
        return _json_error(
            UploadError(str(error) or "Failed to import server video", 500),
            path=path_value,
            phase="import_server_video",
        )


@app.route("/api/uploads/<upload_id>/source", methods=["GET"])
def get_upload_source(upload_id: str) -> Response:
    try:
        source_path = get_upload_source_path(upload_id)
        mimetype = 'video/mp4' if source_path.suffix.lower() == '.dat' else None
        return send_file(source_path, conditional=True, mimetype=mimetype)
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to read upload source %s", upload_id)
        return _json_error(
            UploadError(str(error) or "Failed to read upload source", 500)
        )


@app.route("/api/uploads/<upload_id>", methods=["GET"])
def get_upload(upload_id: str) -> Response:
    try:
        return jsonify(get_upload_session(upload_id))
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to fetch upload session %s", upload_id)
        return _json_error(
            UploadError(str(error) or "Failed to fetch upload session", 500)
        )


@app.route("/api/uploads/<upload_id>", methods=["DELETE"])
def delete_upload(upload_id: str) -> Response:
    try:
        delete_upload_session(upload_id)
        return jsonify({"uploadId": upload_id, "deleted": True})
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to delete upload session %s", upload_id)
        return _json_error(
            UploadError(str(error) or "Failed to delete upload session", 500)
        )


@app.route("/api/uploads/<upload_id>/chunks/<int:index>", methods=["PUT"])
def upload_chunk(upload_id: str, index: int) -> Response:
    try:
        chunk = request.get_data(cache=False)
        return jsonify(write_upload_chunk(upload_id, index, chunk))
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to write upload chunk %s/%s", upload_id, index)
        return _json_error(UploadError(str(error) or "Failed to upload chunk", 500))


@app.route("/api/uploads/<upload_id>/complete", methods=["POST"])
def complete_upload_route(upload_id: str) -> Response:
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        payload = {}

    try:
        return jsonify(
            complete_upload(
                upload_id,
                start_time_sec=payload.get("startTimeSec"),
                end_time_sec=payload.get("endTimeSec"),
            )
        ), 202
    except UploadError as error:
        return _json_error(error)
    except Exception as error:
        logger.exception("Failed to complete upload session %s", upload_id)
        return _json_error(UploadError(str(error) or "Failed to finalize upload", 500))


def _json_error(error: UploadError, **details: Any) -> tuple[Response, int]:
    payload = {"error": str(error)}
    payload.update({key: value for key, value in details.items() if value is not None})
    return jsonify(payload), error.status_code


def gen_track_with_mask_stream(
    boundary: str,
    stream: Generator[Any, None, None],
) -> Generator[bytes, None, None]:
    try:
        for chunk in stream:
            yield MultipartResponseBuilder.build(
                boundary=boundary,
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "Frame-Current": "-1",
                    # Total frames minus the reference frame
                    "Frame-Total": "-1",
                    "Mask-Type": "RLE[]",
                },
                body=chunk.to_json().encode("UTF-8"),
            ).get_message()
    except GeneratorExit:
        close = getattr(stream, "close", None)
        if close is not None:
            close()
        raise
    except Exception:
        logger.exception("propagation stream failed")
        raise
    finally:
        close = getattr(stream, "close", None)
        if close is not None:
            close()


class MyGraphQLView(GraphQLView):
    def get_context(self, request: Request, response: Response) -> Any:
        return {"inference_api": inference_api}


# Add GraphQL route to Flask app.
app.add_url_rule(
    "/graphql",
    view_func=MyGraphQLView.as_view(
        "graphql_view",
        schema=schema,
        # Disable GET queries
        # https://strawberry.rocks/docs/operations/deployment
        # https://strawberry.rocks/docs/integrations/flask
        allow_queries_via_get=False,
        # Strawberry recently changed multipart request handling, which now
        # requires enabling support explicitly for views.
        # https://github.com/strawberry-graphql/strawberry/issues/3655
        multipart_uploads_enabled=True,
    ),
)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
