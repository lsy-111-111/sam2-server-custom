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
import {
  createReadyVideoData,
  uploadErrorAtom,
  uploadingStateAtom,
  uploadSessionAtom,
  VideoData,
} from '@/demo/atoms';
import {MAX_UPLOAD_VIDEO_DURATION_SECONDS} from '@/demo/DemoConfig';
import {useAtomValue, useSetAtom, useStore} from 'jotai';
import {useCallback} from 'react';

type ClearUploadSessionOptions = {
  deleteRemote?: boolean;
  clearError?: boolean;
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
};

const REMOTE_DELETE_TIMEOUT_MS = 5000;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
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

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Upload aborted', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort);
  });
}

export default function useUploadSession() {
  const store = useStore();
  const uploadSession = useAtomValue(uploadSessionAtom);
  const setUploadSession = useSetAtom(uploadSessionAtom);
  const setUploadingState = useSetAtom(uploadingStateAtom);
  const setUploadError = useSetAtom(uploadErrorAtom);

  const setSessionForUploadId = useCallback(
    (
      uploadId: string,
      updater: (currentSession: NonNullable<typeof uploadSession>) => NonNullable<typeof uploadSession>,
    ) => {
      setUploadSession(currentSession => {
        if (currentSession == null || currentSession.uploadId !== uploadId) {
          return currentSession;
        }
        return updater(currentSession);
      });
    },
    [setUploadSession],
  );

  const clearUploadSession = useCallback(
    async ({
      deleteRemote = true,
      clearError = true,
    }: ClearUploadSessionOptions = {}) => {
      const currentUploadSession = store.get(uploadSessionAtom);
      const uploadId = currentUploadSession?.uploadId;
      const objectUrl = currentUploadSession?.objectUrl;
      const shouldRevokeObjectUrl =
        currentUploadSession?.shouldRevokeObjectUrl ?? false;

      if (currentUploadSession?.controller != null) {
        currentUploadSession.controller.abort();
      }

      setUploadSession(null);
      setUploadingState('default');
      if (clearError) {
        setUploadError(null);
      }

      if (shouldRevokeObjectUrl && objectUrl != null) {
        URL.revokeObjectURL(objectUrl);
      }

      if (deleteRemote && uploadId != null && uploadId !== '') {
        // Remote cleanup should never block switching to another video.
        void fetchWithTimeout(
          `/api/uploads/${uploadId}`,
          {
            method: 'DELETE',
          },
          REMOTE_DELETE_TIMEOUT_MS,
        ).catch(() => {
          // Best effort cleanup. Local state is already cleared.
        });
      }
    },
    [setUploadError, setUploadSession, setUploadingState, store],
  );

  const setSelectedClip = useCallback(
    (startTimeSec: number, endTimeSec: number) => {
      setUploadSession(currentSession => {
        if (
          currentSession == null ||
          currentSession.status === 'processing' ||
          currentSession.status === 'ready'
        ) {
          return currentSession;
        }

        const maxSelectableTimeSec = Math.max(
          1,
          Math.ceil(currentSession.sourceDurationSec),
        );
        const nextStartTimeSec = Math.max(
          0,
          Math.min(Math.round(startTimeSec), maxSelectableTimeSec - 1),
        );
        const nextEndUpperBound = Math.min(
          Math.round(endTimeSec),
          nextStartTimeSec + MAX_UPLOAD_VIDEO_DURATION_SECONDS,
        );
        const nextEndTimeSec = Math.max(
          nextStartTimeSec + 1,
          Math.min(nextEndUpperBound, maxSelectableTimeSec),
        );

        return {
          ...currentSession,
          selectedStartTimeSec: nextStartTimeSec,
          selectedEndTimeSec: nextEndTimeSec,
        };
      });
    },
    [setUploadSession],
  );

  const prepareSelectedClip = useCallback(async (): Promise<VideoData | null> => {
    const currentUploadSession = store.get(uploadSessionAtom);
    if (currentUploadSession?.readyVideo != null) {
      return currentUploadSession.readyVideo;
    }
    if (
      currentUploadSession == null ||
      currentUploadSession.uploadId == null ||
      currentUploadSession.status !== 'uploaded'
    ) {
      return null;
    }

    const {uploadId, controller, selectedStartTimeSec, selectedEndTimeSec} =
      currentUploadSession;

    try {
      setUploadingState('processing');
      setUploadError(null);
      setSessionForUploadId(uploadId, currentSession => ({
        ...currentSession,
        status: 'processing',
        error: null,
      }));

      const processingStatus = await requestJson<UploadStatusResponse>(
        `/api/uploads/${uploadId}/complete`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            startTimeSec: selectedStartTimeSec,
            endTimeSec: selectedEndTimeSec,
          }),
          signal: controller.signal,
        },
      );

      setSessionForUploadId(uploadId, currentSession => ({
        ...currentSession,
        status: processingStatus.status === 'ready' ? 'ready' : 'processing',
        uploadedBytes: processingStatus.uploadedBytes,
        totalBytes: processingStatus.totalBytes,
        chunkSizeBytes: processingStatus.chunkSizeBytes,
        error: null,
      }));

      while (true) {
        const status = await requestJson<UploadStatusResponse>(
          `/api/uploads/${uploadId}`,
          {
            method: 'GET',
            signal: controller.signal,
          },
        );

        if (status.status === 'failed') {
          throw new Error(status.error ?? 'Preparing the selected clip failed.');
        }

        if (status.status === 'ready' && status.video != null) {
          const readyVideo = createReadyVideoData(status.video);
          setUploadingState('ready');
          setUploadError(null);
          setSessionForUploadId(uploadId, currentSession => ({
            ...currentSession,
            status: 'ready',
            uploadedBytes: status.uploadedBytes,
            totalBytes: status.totalBytes,
            chunkSizeBytes: status.chunkSizeBytes,
            readyVideo,
            error: null,
          }));
          return readyVideo;
        }

        setUploadingState('processing');
        setSessionForUploadId(uploadId, currentSession => ({
          ...currentSession,
          status: 'processing',
          uploadedBytes: status.uploadedBytes,
          totalBytes: status.totalBytes,
          chunkSizeBytes: status.chunkSizeBytes,
          error: null,
        }));

        await delay(1000, controller.signal);
      }
    } catch (error) {
      if (isAbortError(error)) {
        return null;
      }

      const uploadError =
        error instanceof Error
          ? error
          : new Error('Preparing the selected clip failed.');
      setUploadingState('error');
      setUploadError(uploadError.message);
      setSessionForUploadId(uploadId, currentSession => ({
        ...currentSession,
        status: 'error',
        error: uploadError.message,
      }));
      return null;
    }
  }, [setSessionForUploadId, setUploadError, setUploadingState, store]);

  return {
    uploadSession,
    clearUploadSession,
    setSelectedClip,
    prepareSelectedClip,
  };
}
