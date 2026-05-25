/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import useVideo from '@/common/components/video/editor/useVideo';
import {
  normalizeFrameListFileName,
  validateFrameListIndices,
} from '@/common/components/options/frameListExport';
import {
  AnnotationExportPayload,
  SegmentationPoint,
} from '@/common/tracker/Tracker';
import {
  annotationExportSnapshotAtom,
  createReadyVideoData,
  inputVideoAtom,
  trackletObjectNamesAtom,
  TrackletObjectNames,
  trimRangeAtom,
  uploadSessionAtom,
} from '@/demo/atoms';
import type {
  DirectoryPickerWindow,
  LocalFileSystemDirectoryHandle,
} from '@/types/file-system-access';
import {useAtomValue} from 'jotai';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {useLocation, useNavigate} from 'react-router-dom';

type ExportAnnotationsState = 'idle' | 'saving' | 'saved';

export type AnnotationExportSamplingConfig =
  | {
      mode: 'frames';
      everyNFrames: number;
    }
  | {
      mode: 'seconds';
      everyNSeconds: number;
    }
  | {
      mode: 'frameList';
      frameIndices: number[];
      frameListFileName: string;
      totalFrames?: number;
    };

type NormalizedAnnotationExportSampling = {
  mode: 'frames' | 'seconds' | 'frameList';
  everyNFrames: number;
  everyNSeconds?: number;
  sourceFps?: number;
  frameIndices?: number[];
  frameListFileName?: string;
};

type ExportArchiveResponse = {
  blob: Blob;
  exportDir: string;
  fileName: string;
};

type RemainderVideoResponse = {
  hasRemainder: boolean;
  video?: RemainderVideoResponseVideo | null;
};

type RemainderVideoResponseVideo = {
  path: string;
  posterPath: string | null | undefined;
  url: string;
  posterUrl: string | null | undefined;
  width: number;
  height: number;
};

const EXPORT_ARCHIVE_ENDPOINT = '/api/annotations/export/archive';
const REMAINDER_ENDPOINT = '/api/videos/remainder';
const RESPONSE_PREVIEW_CHARS = 240;
const MISSING_VIDEO_SOURCE_ERROR = '??????????????????????????';
const LOCAL_FOLDER_PICKER_ERROR =
  'This browser cannot choose a local folder. Open SAM2 with the Chrome or Edge LAN launcher and try again.';
const HEALTH_ENDPOINT = '/healthy';
const HEALTH_PROBE_TIMEOUT_MS = 3000;

function summarizeBodyText(bodyText: string): string {
  const normalizedText = bodyText.replace(/\s+/g, ' ').trim();
  if (normalizedText.length <= RESPONSE_PREVIEW_CHARS) {
    return normalizedText;
  }
  return `${normalizedText.slice(0, RESPONSE_PREVIEW_CHARS)}...`;
}

function isJsonContentType(contentType: string | null): boolean {
  return (contentType ?? '').toLowerCase().includes('json');
}

function buildUnexpectedResponseError(
  endpoint: string,
  response: Response,
  bodyText: string,
  action: string,
): Error {
  const contentType = response.headers.get('content-type') ?? 'unknown';
  if (contentType.toLowerCase().includes('text/html')) {
    return new Error(
      `${action} failed: ${endpoint} returned HTML instead of JSON (status ${response.status}). The frontend likely served the app shell instead of proxying the API request to the backend.`,
    );
  }

  const bodyPreview = summarizeBodyText(bodyText);
  if (bodyPreview.length > 0) {
    return new Error(
      `${action} failed: expected JSON from ${endpoint}, got ${contentType} (status ${response.status}). Response preview: ${bodyPreview}`,
    );
  }

  return new Error(
    `${action} failed: expected JSON from ${endpoint}, got ${contentType} (status ${response.status}).`,
  );
}

function buildHttpError(
  endpoint: string,
  response: Response,
  bodyText: string,
  action: string,
): Error {
  if (bodyText.trim().length > 0) {
    try {
      const body = JSON.parse(bodyText) as {error?: string};
      if (body.error != null && body.error.trim().length > 0) {
        return new Error(`${action} failed: ${body.error}`);
      }
    } catch {
      // Fall through to text-based handling below.
    }
  }

  if (
    (response.headers.get('content-type') ?? '')
      .toLowerCase()
      .includes('text/html')
  ) {
    return new Error(
      `${action} failed: ${endpoint} returned HTML with status ${response.status}. The frontend likely did not proxy this API request and served the app shell instead.`,
    );
  }

  const bodyPreview = summarizeBodyText(bodyText);
  if (bodyPreview.length > 0) {
    return new Error(
      `${action} failed with status ${response.status}: ${bodyPreview}`,
    );
  }

  return new Error(`${action} failed with status ${response.status}.`);
}

function buildInvalidJsonError(
  endpoint: string,
  bodyText: string,
  action: string,
): Error {
  const bodyPreview = summarizeBodyText(bodyText);
  if (bodyPreview.length > 0) {
    return new Error(
      `${action} failed: ${endpoint} returned invalid JSON. Response preview: ${bodyPreview}`,
    );
  }

  return new Error(`${action} failed: ${endpoint} returned invalid JSON.`);
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  action: string = 'Request',
): Promise<T> {
  const endpoint = typeof input === 'string' ? input : input.toString();
  const response = await fetch(input, init);
  const bodyText = await response.text();

  if (!response.ok) {
    throw buildHttpError(endpoint, response, bodyText, action);
  }

  if (!isJsonContentType(response.headers.get('content-type'))) {
    throw buildUnexpectedResponseError(endpoint, response, bodyText, action);
  }

  try {
    return JSON.parse(bodyText) as T;
  } catch {
    throw buildInvalidJsonError(endpoint, bodyText, action);
  }
}

async function requestArchive(
  input: RequestInfo | URL,
  init?: RequestInit,
  action: string = 'Request',
): Promise<ExportArchiveResponse> {
  const endpoint = typeof input === 'string' ? input : input.toString();
  const response = await fetch(input, init);

  if (!response.ok) {
    const bodyText = await response.text();
    throw buildHttpError(endpoint, response, bodyText, action);
  }

  const fileName = getArchiveFileName(response);
  return {
    blob: await response.blob(),
    exportDir:
      response.headers.get('X-SAM2-Export-Dir') ??
      fileName.replace(/\.zip$/i, ''),
    fileName,
  };
}

function getArchiveFileName(response: Response): string {
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? 'sam2_export.zip';
}

function getFolderPicker(): DirectoryPickerWindow['showDirectoryPicker'] {
  return (window as DirectoryPickerWindow).showDirectoryPicker;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

async function writeArchiveToLocalDirectory(
  archive: ExportArchiveResponse,
  directoryHandle: LocalFileSystemDirectoryHandle,
): Promise<void> {
  const fileHandle = await directoryHandle.getFileHandle(archive.fileName, {
    create: true,
  });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(archive.blob);
  } finally {
    await writable.close();
  }
}

function triggerBrowserDownload(archive: ExportArchiveResponse): void {
  const objectUrl = URL.createObjectURL(archive.blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = archive.fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

function getReadableErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }
  return '';
}

function isFetchNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  const message = getReadableErrorMessage(error).toLowerCase();
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('load failed')
  );
}

async function canReachHealthEndpoint(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    HEALTH_PROBE_TIMEOUT_MS,
  );
  try {
    const response = await fetch(HEALTH_ENDPOINT, {
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function buildExportFailureMessage(error: unknown): Promise<string> {
  const message = getReadableErrorMessage(error);
  if (!isFetchNetworkError(error)) {
    return message.length > 0 ? message : 'Could not export annotations.';
  }

  const healthUrl = `${window.location.origin}${HEALTH_ENDPOINT}`;
  if (await canReachHealthEndpoint()) {
    return `Export request was interrupted before the ZIP response could be read, but ${HEALTH_ENDPOINT} is reachable. Open SAM2 with the LAN launcher and check VPN, proxy, security software, or browser extensions on this computer. Browser error: ${message}`;
  }

  return `Cannot reach the SAM2 server from this browser. Open ${healthUrl}; if it does not show OK, check the LAN connection, VPN, firewall, or server listener. Browser error: ${message}`;
}

export function normalizeExportEveryNFrames(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
}

export function normalizeExportEveryNSeconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return value;
}

function normalizeExportSamplingConfig(
  samplingConfig: AnnotationExportSamplingConfig,
  sourceFps: number,
): NormalizedAnnotationExportSampling {
  if (samplingConfig.mode === 'frames') {
    if (
      !Number.isFinite(samplingConfig.everyNFrames) ||
      samplingConfig.everyNFrames < 1
    ) {
      throw new Error('Every N frames must be a positive integer.');
    }

    return {
      mode: 'frames',
      everyNFrames: normalizeExportEveryNFrames(samplingConfig.everyNFrames),
    };
  }

  if (samplingConfig.mode === 'frameList') {
    return {
      mode: 'frameList',
      everyNFrames: 1,
      frameIndices: validateFrameListIndices(
        samplingConfig.frameIndices,
        samplingConfig.totalFrames,
      ),
      frameListFileName: normalizeFrameListFileName(
        samplingConfig.frameListFileName,
      ),
    };
  }

  if (
    !Number.isFinite(samplingConfig.everyNSeconds) ||
    samplingConfig.everyNSeconds <= 0
  ) {
    throw new Error('Every N seconds must be a positive number.');
  }

  if (!Number.isFinite(sourceFps) || sourceFps <= 0) {
    throw new Error(
      'Could not determine the video FPS for seconds-based export.',
    );
  }

  const everyNSeconds = normalizeExportEveryNSeconds(
    samplingConfig.everyNSeconds,
  );
  return {
    mode: 'seconds',
    everyNFrames: Math.max(1, Math.round(everyNSeconds * sourceFps)),
    everyNSeconds,
    sourceFps,
  };
}

function clonePoint(point: SegmentationPoint): SegmentationPoint {
  return [point[0], point[1], point[2]];
}

function getAnnotationObjectName(
  objectId: number,
  objectNames: TrackletObjectNames,
): string {
  const customName = objectNames[objectId]?.trim();
  return customName != null && customName.length > 0
    ? customName
    : `Object ${objectId + 1}`;
}

function cloneAnnotationExportFrame(
  frameIndex: number,
  frame: AnnotationExportPayload['frames'][number] | undefined,
  objectNames: TrackletObjectNames,
): AnnotationExportPayload['frames'][number] {
  return {
    frame_index: frameIndex,
    annotations: (frame?.annotations ?? []).map(annotation => ({
      object_id: annotation.object_id,
      object_name: getAnnotationObjectName(annotation.object_id, objectNames),
      rle: {
        size: [annotation.rle.size[0], annotation.rle.size[1]],
        counts: annotation.rle.counts,
      },
      points: annotation.points.map(clonePoint),
    })),
  };
}

export function filterAnnotationExportPayload(
  payload: AnnotationExportPayload,
  samplingConfig: AnnotationExportSamplingConfig,
  objectNames: TrackletObjectNames = {},
  sourceFps: number = 0,
): AnnotationExportPayload {
  const normalizedSampling = normalizeExportSamplingConfig(
    samplingConfig,
    sourceFps,
  );

  if (normalizedSampling.mode === 'frameList') {
    const framesByIndex = new Map(
      payload.frames.map(frame => [frame.frame_index, frame]),
    );
    const frameIndices = normalizedSampling.frameIndices ?? [];

    return {
      session_id: payload.session_id,
      export_every_n_frames: 1,
      export_sampling_mode: 'frame_list',
      export_frame_list_file_name: normalizedSampling.frameListFileName,
      export_frame_indices: frameIndices,
      frames: frameIndices.map(frameIndex =>
        cloneAnnotationExportFrame(
          frameIndex,
          framesByIndex.get(frameIndex),
          objectNames,
        ),
      ),
    };
  }

  return {
    session_id: payload.session_id,
    export_every_n_frames: normalizedSampling.everyNFrames,
    export_sampling_mode: normalizedSampling.mode,
    ...(normalizedSampling.everyNSeconds != null
      ? {export_every_n_seconds: normalizedSampling.everyNSeconds}
      : {}),
    ...(normalizedSampling.sourceFps != null
      ? {export_source_fps: normalizedSampling.sourceFps}
      : {}),
    frames: payload.frames
      .filter(
        frame => frame.frame_index % normalizedSampling.everyNFrames === 0,
      )
      .map(frame =>
        cloneAnnotationExportFrame(frame.frame_index, frame, objectNames),
      ),
  };
}

export default function useExportAnnotations() {
  const annotationSnapshot = useAtomValue(annotationExportSnapshotAtom);
  const inputVideo = useAtomValue(inputVideoAtom);
  const objectNames = useAtomValue(trackletObjectNamesAtom);
  const uploadSession = useAtomValue(uploadSessionAtom);
  const trimRange = useAtomValue(trimRangeAtom);
  const video = useVideo();
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<ExportAnnotationsState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [remainderMessage, setRemainderMessage] = useState<string | null>(null);

  const hasSnapshot = annotationSnapshot != null;
  const canExport = hasSnapshot && state !== 'saving';
  const isLocalFolderPickerSupported = getFolderPicker() != null;
  const sourceFps = video?.fps ?? 0;
  const sourceFrameCount = video?.numberOfFrames ?? 0;

  useEffect(() => {
    setError(null);
    setSavedPath(null);
    setSaveMessage(null);
    setRemainderMessage(null);
    setState('idle');
  }, [inputVideo?.path]);

  const chooseLocalDirectory = useCallback(async () => {
    const showDirectoryPicker = getFolderPicker();
    if (showDirectoryPicker == null) {
      setError(LOCAL_FOLDER_PICKER_ERROR);
      return null;
    }

    try {
      const directoryHandle = await showDirectoryPicker({mode: 'readwrite'});
      setError(null);
      setSavedPath(null);
      return directoryHandle;
    } catch (pickerError) {
      if (!isAbortLikeError(pickerError)) {
        setError('Could not choose a local export folder.');
      }
      return null;
    }
  }, []);

  const loadRemainingVideo = useCallback(async () => {
    if (video == null) {
      setRemainderMessage(
        'Annotations exported. Could not check the remaining video segment because the video is not ready.',
      );
      return;
    }

    const totalFrames = Math.max(0, Math.floor(video.numberOfFrames));
    if (totalFrames <= 0) {
      setRemainderMessage(
        'Annotations exported. Could not check the remaining video segment because the frame count is unavailable.',
      );
      return;
    }

    setRemainderMessage(
      'Annotations exported. Preparing remaining video segment...',
    );
    const response = await requestJson<RemainderVideoResponse>(
      REMAINDER_ENDPOINT,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          videoPath: inputVideo?.path ?? null,
          uploadId: uploadSession?.uploadId ?? null,
          trimEndFrameExclusive: trimRange.endFrameExclusive,
          totalFrames,
        }),
      },
      'Remainder video',
    );

    if (response.hasRemainder && response.video != null) {
      setRemainderMessage('Loading remaining video segment...');
      navigate(location.pathname, {
        state: {
          video: createReadyVideoData(response.video),
        },
      });
      return;
    }

    setRemainderMessage('Annotations exported. No remaining video segment.');
  }, [
    inputVideo?.path,
    location.pathname,
    navigate,
    trimRange.endFrameExclusive,
    uploadSession?.uploadId,
    video,
  ]);

  const exportAnnotations = useCallback(
    async (
      directoryHandle: LocalFileSystemDirectoryHandle | null,
      samplingConfig: AnnotationExportSamplingConfig,
    ) => {
      setSaveMessage(null);
      if (annotationSnapshot == null) {
        setError(
          'No annotation snapshot is available yet. Finish tracking and click Good to go first.',
        );
        setSavedPath(null);
        setRemainderMessage(null);
        setState('idle');
        return null;
      }

      const videoPath = inputVideo?.path ?? null;
      const uploadId = uploadSession?.uploadId ?? null;
      if (
        (videoPath == null || videoPath.trim().length === 0) &&
        (uploadId == null || uploadId.trim().length === 0)
      ) {
        setError(MISSING_VIDEO_SOURCE_ERROR);
        setSavedPath(null);
        setRemainderMessage(null);
        setState('idle');
        return null;
      }

      setError(null);
      setSavedPath(null);
      setRemainderMessage(null);
      setState('saving');

      try {
        const filteredPayload = filterAnnotationExportPayload(
          annotationSnapshot,
          samplingConfig,
          objectNames,
          sourceFps,
        );
        const archive = await requestArchive(
          EXPORT_ARCHIVE_ENDPOINT,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              payload: filteredPayload,
              videoPath,
              uploadId,
            }),
          },
          'Annotation export',
        );

        if (directoryHandle != null) {
          try {
            await writeArchiveToLocalDirectory(archive, directoryHandle);
            setSavedPath(`${directoryHandle.name}/${archive.fileName}`);
            setSaveMessage(null);
          } catch (localWriteError) {
            triggerBrowserDownload(archive);
            setSavedPath(`browser downloads/${archive.fileName}`);
            const localWriteMessage = getReadableErrorMessage(localWriteError);
            setSaveMessage(
              `Local folder write failed, so the ZIP was sent to browser downloads.${
                localWriteMessage.length > 0 ? ` ${localWriteMessage}` : ''
              }`,
            );
          }
        } else {
          triggerBrowserDownload(archive);
          setSavedPath(`browser downloads/${archive.fileName}`);
          setSaveMessage(
            isLocalFolderPickerSupported
              ? 'No local folder was selected, so the ZIP was sent to browser downloads.'
              : `${LOCAL_FOLDER_PICKER_ERROR} The ZIP was sent to browser downloads.`,
          );
        }
        try {
          await loadRemainingVideo();
        } catch (remainderError) {
          const message =
            remainderError instanceof Error &&
            remainderError.message.trim().length > 0
              ? remainderError.message
              : 'Could not load the remaining video segment.';
          setRemainderMessage(
            'Annotations exported, but the remaining video segment could not be loaded.',
          );
          setError(
            `Annotations exported, but remainder loading failed: ${message}`,
          );
        }
        setState('saved');
        return archive;
      } catch (nextError) {
        setError(await buildExportFailureMessage(nextError));
        setSavedPath(null);
        setSaveMessage(null);
        setRemainderMessage(null);
        setState('idle');
        return null;
      }
    },
    [
      annotationSnapshot,
      inputVideo?.path,
      isLocalFolderPickerSupported,
      loadRemainingVideo,
      objectNames,
      sourceFps,
      uploadSession?.uploadId,
    ],
  );

  return useMemo(
    () => ({
      canExport,
      chooseLocalDirectory,
      error,
      exportAnnotations,
      hasSnapshot,
      isLocalFolderPickerSupported,
      remainderMessage,
      saveMessage,
      savedPath,
      sourceFps,
      sourceFrameCount,
      state,
    }),
    [
      canExport,
      chooseLocalDirectory,
      error,
      exportAnnotations,
      hasSnapshot,
      isLocalFolderPickerSupported,
      remainderMessage,
      saveMessage,
      savedPath,
      sourceFps,
      sourceFrameCount,
      state,
    ],
  );
}
