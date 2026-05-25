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
import useUploadSession from '@/common/components/upload/useUploadSession';
import Logger from '@/common/logger/Logger';
import {
  createPreviewVideoData,
  uploadErrorAtom,
  UploadSession,
  uploadingStateAtom,
  uploadSessionAtom,
  VideoData,
} from '@/demo/atoms';
import {
  MAX_UPLOAD_FILE_SIZE_MB,
  MAX_UPLOAD_VIDEO_DURATION_SECONDS,
} from '@/demo/DemoConfig';
import {useSetAtom} from 'jotai';
import {useEffect, useRef, useState} from 'react';
import {FileRejection, FileWithPath, useDropzone} from 'react-dropzone';

const DAT_VIDEO_MIME_TYPE = 'video/mp4';

const ACCEPT_VIDEOS = {
  'video/mp4': ['.mp4', '.dat'],
  'video/quicktime': ['.mov'],
  'application/octet-stream': ['.dat'],
};

const MAX_VIDEO_UPLOAD_SIZE = MAX_UPLOAD_FILE_SIZE_MB * 1024 ** 2;

type Props = {
  onUpload: (video: VideoData) => void;
  onUploadStart?: () => void;
  onUploadError?: (error: Error) => void;
};

type UploadStatusResponse = {
  uploadId: string;
  status: 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed';
  uploadedBytes: number;
  totalBytes: number;
  chunkSizeBytes: number;
  error?: string | null;
  video?: {
    path: string;
    posterPath: string | null | undefined;
    url: string;
    posterUrl: string | null | undefined;
    width: number;
    height: number;
  } | null;
  previewVideo?: {
    url: string;
    posterPath: string | null | undefined;
    posterUrl: string | null | undefined;
    width: number;
    height: number;
  } | null;
  sourceDurationSec?: number | null;
};

function getUploadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return 'Upload failed for an unknown reason.';
}

function getFileRejectionMessage(fileRejection: FileRejection): string {
  const firstError = fileRejection.errors[0];
  if (firstError == null) {
    return 'File not accepted. Please try another video.';
  }

  switch (firstError.code) {
    case 'file-too-large':
      return `File too large. Try a video under ${MAX_UPLOAD_FILE_SIZE_MB} MB.`;
    case 'file-invalid-type':
      return 'Unsupported video type. Please upload an MP4, MOV, or DAT file.';
    case 'too-many-files':
      return 'Too many files. Please upload one video at a time.';
    default:
      return (
        firstError.message || 'File not accepted. Please try another video.'
      );
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isDatVideoFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.dat');
}

function getPreviewVideoBlob(file: File): Blob {
  if (!isDatVideoFile(file) || file.type.toLowerCase().startsWith('video/')) {
    return file;
  }

  return file.slice(0, file.size, DAT_VIDEO_MIME_TYPE);
}

function getUploadContentType(file: File): string {
  if (
    isDatVideoFile(file) &&
    (file.type === '' || file.type === 'application/octet-stream')
  ) {
    return DAT_VIDEO_MIME_TYPE;
  }

  return file.type;
}

function getUploadSourceDurationSec(
  uploadStatus: UploadStatusResponse,
): number | null {
  const sourceDurationSec = uploadStatus.sourceDurationSec;
  if (
    sourceDurationSec == null ||
    !Number.isFinite(sourceDurationSec) ||
    sourceDurationSec <= 0
  ) {
    return null;
  }

  return Math.ceil(sourceDurationSec);
}

function createBackendPreviewVideoData(
  uploadStatus: UploadStatusResponse,
): VideoData | null {
  const previewVideo = uploadStatus.previewVideo;
  if (previewVideo == null) {
    return null;
  }

  return createPreviewVideoData({
    url: previewVideo.url,
    posterPath: previewVideo.posterPath,
    posterUrl: previewVideo.posterUrl,
    width: previewVideo.width,
    height: previewVideo.height,
  });
}

async function getResponseError(response: Response): Promise<Error> {
  const bodyText = await response.text();
  if (bodyText.trim().length > 0) {
    try {
      const body = JSON.parse(bodyText) as {error?: string};
      if (body.error != null && body.error.trim().length > 0) {
        return new Error(body.error);
      }
    } catch {
      return new Error(bodyText);
    }
    return new Error(bodyText);
  }

  return new Error(`Request failed with status ${response.status}.`);
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw await getResponseError(response);
  }
  return (await response.json()) as T;
}

async function readLocalVideoMetadata(objectUrl: string): Promise<{
  width: number;
  height: number;
  durationSec: number;
}> {
  return await new Promise((resolve, reject) => {
    const video = document.createElement('video');

    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };

    video.preload = 'metadata';
    video.playsInline = true;
    video.onloadedmetadata = () => {
      const durationSec = Math.ceil(video.duration);
      if (!Number.isFinite(durationSec) || durationSec <= 0) {
        cleanup();
        reject(new Error('Could not read local video duration.'));
        return;
      }

      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      cleanup();
      resolve({width, height, durationSec});
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Could not read local video metadata.'));
    };
    video.src = objectUrl;
  });
}

export default function useUploadVideo({
  onUpload,
  onUploadStart,
  onUploadError,
}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const mountedRef = useRef(true);
  const setUploadSession = useSetAtom(uploadSessionAtom);
  const setUploadingState = useSetAtom(uploadingStateAtom);
  const setUploadError = useSetAtom(uploadErrorAtom);
  const {clearUploadSession} = useUploadSession();

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function setLocalUploading(nextValue: boolean) {
    if (mountedRef.current) {
      setIsUploading(nextValue);
    }
  }

  function reportUploadError(uploadError: Error): void {
    const message = getUploadErrorMessage(uploadError);
    setError(message);
    setUploadError(message);
    setUploadingState('error');
    onUploadError?.(uploadError);
  }

  const {getRootProps, getInputProps} = useDropzone({
    accept: ACCEPT_VIDEOS,
    multiple: false,
    maxFiles: 1,
    onDrop: async (
      acceptedFiles: FileWithPath[],
      fileRejections: FileRejection[],
    ) => {
      setError(null);
      setUploadError(null);

      if (fileRejections.length > 0) {
        reportUploadError(new Error(getFileRejectionMessage(fileRejections[0])));
        return;
      }

      if (acceptedFiles.length === 0) {
        reportUploadError(
          new Error('File not accepted. Please try another video.'),
        );
        return;
      }
      if (acceptedFiles.length > 1) {
        reportUploadError(
          new Error('Too many files. Please upload one video at a time.'),
        );
        return;
      }

      const file = acceptedFiles[0];
      const objectUrl = URL.createObjectURL(getPreviewVideoBlob(file));
      const controller = new AbortController();

      const setSessionForCurrentUpload = (
        updater: (currentSession: UploadSession) => UploadSession,
      ) => {
        setUploadSession(currentSession => {
          if (currentSession == null || currentSession.objectUrl !== objectUrl) {
            return currentSession;
          }
          return updater(currentSession);
        });
      };

      let storedPreviewSession = false;

      try {
        await clearUploadSession();
        onUploadStart?.();
        setLocalUploading(true);
        setUploadingState('uploading');

        let hasLocalPreviewSession = false;
        try {
          const {width, height, durationSec} = await readLocalVideoMetadata(
            objectUrl,
          );
          const previewVideo = createPreviewVideoData({
            url: objectUrl,
            width,
            height,
          });
          const initialSelectedEndTimeSec = Math.min(
            durationSec,
            MAX_UPLOAD_VIDEO_DURATION_SECONDS,
          );

          const initialUploadSession: UploadSession = {
            uploadId: null,
            status: 'uploading',
            uploadedBytes: 0,
            totalBytes: file.size,
            chunkSizeBytes: null,
            objectUrl,
            shouldRevokeObjectUrl: true,
            controller,
            previewVideo,
            readyVideo: null,
            error: null,
            sourceDurationSec: durationSec,
            selectedStartTimeSec: 0,
            selectedEndTimeSec: Math.max(1, initialSelectedEndTimeSec),
          };

          setUploadSession(initialUploadSession);
          storedPreviewSession = true;
          hasLocalPreviewSession = true;
          onUpload(previewVideo);
        } catch (metadataError) {
          if (!isDatVideoFile(file)) {
            throw metadataError;
          }
        }

        const createdUpload = await requestJson<UploadStatusResponse>(
          '/api/uploads',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              filename: file.name,
              sizeBytes: file.size,
              contentType: getUploadContentType(file),
            }),
            signal: controller.signal,
          },
        );

        setSessionForCurrentUpload(currentSession => ({
          ...currentSession,
          uploadId: createdUpload.uploadId,
          uploadedBytes: createdUpload.uploadedBytes,
          totalBytes: createdUpload.totalBytes,
          chunkSizeBytes: createdUpload.chunkSizeBytes,
          status: createdUpload.status === 'uploaded' ? 'uploaded' : 'uploading',
        }));

        const chunkSize = createdUpload.chunkSizeBytes;
        const totalChunks = Math.ceil(file.size / chunkSize);
        let latestUploadStatus = createdUpload;

        for (let index = 0; index < totalChunks; index += 1) {
          const start = index * chunkSize;
          const end = Math.min(start + chunkSize, file.size);
          const chunk = file.slice(start, end);

          const chunkStatus = await requestJson<UploadStatusResponse>(
            `/api/uploads/${createdUpload.uploadId}/chunks/${index}`,
            {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/octet-stream',
              },
              body: chunk,
              signal: controller.signal,
            },
          );
          latestUploadStatus = chunkStatus;

          setSessionForCurrentUpload(currentSession => ({
            ...currentSession,
            uploadedBytes: chunkStatus.uploadedBytes,
            totalBytes: chunkStatus.totalBytes,
            chunkSizeBytes: chunkStatus.chunkSizeBytes,
            status: chunkStatus.status === 'uploaded' ? 'uploaded' : 'uploading',
          }));
        }

        if (!hasLocalPreviewSession) {
          const backendPreviewVideo =
            createBackendPreviewVideoData(latestUploadStatus);
          const sourceDurationSec =
            getUploadSourceDurationSec(latestUploadStatus);
          if (backendPreviewVideo == null || sourceDurationSec == null) {
            throw new Error('Could not read uploaded DAT video metadata.');
          }

          const initialSelectedEndTimeSec = Math.min(
            sourceDurationSec,
            MAX_UPLOAD_VIDEO_DURATION_SECONDS,
          );
          const backendUploadSession: UploadSession = {
            uploadId: createdUpload.uploadId,
            status: 'uploaded',
            uploadedBytes: latestUploadStatus.uploadedBytes,
            totalBytes: latestUploadStatus.totalBytes,
            chunkSizeBytes: latestUploadStatus.chunkSizeBytes,
            objectUrl,
            shouldRevokeObjectUrl: true,
            controller,
            previewVideo: backendPreviewVideo,
            readyVideo: null,
            error: null,
            sourceDurationSec,
            selectedStartTimeSec: 0,
            selectedEndTimeSec: Math.max(1, initialSelectedEndTimeSec),
          };

          setUploadSession(backendUploadSession);
          storedPreviewSession = true;
          onUpload(backendPreviewVideo);
        }

        setUploadingState('uploaded');
        setUploadError(null);
        setSessionForCurrentUpload(currentSession => ({
          ...currentSession,
          status: 'uploaded',
          uploadedBytes: file.size,
          totalBytes: file.size,
          error: null,
        }));
      } catch (uploadError) {
        if (!isAbortError(uploadError)) {
          const uploadException =
            uploadError instanceof Error
              ? uploadError
              : new Error(getUploadErrorMessage(uploadError));
          Logger.error(uploadException);
          reportUploadError(uploadException);
          setUploadSession(currentSession => {
            if (currentSession == null || currentSession.objectUrl !== objectUrl) {
              return currentSession;
            }
            return {
              ...currentSession,
              status: 'error',
              error: getUploadErrorMessage(uploadException),
            };
          });
        }
      } finally {
        if (!storedPreviewSession) {
          URL.revokeObjectURL(objectUrl);
        }
        setLocalUploading(false);
      }
    },
    onError: uploadError => {
      Logger.error(uploadError);
      reportUploadError(uploadError);
    },
    maxSize: MAX_VIDEO_UPLOAD_SIZE,
  });

  return {
    getRootProps,
    getInputProps,
    isUploading,
    error,
    setError,
  };
}
