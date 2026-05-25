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
import {
  createPreviewVideoData,
  UploadSession,
  uploadingStateAtom,
  uploadSessionAtom,
  VideoData,
} from '@/demo/atoms';
import {MAX_UPLOAD_VIDEO_DURATION_SECONDS} from '@/demo/DemoConfig';
import {useSetAtom} from 'jotai';
import {useCallback, useEffect, useRef, useState} from 'react';

type Props = {
  onUpload: (video: VideoData) => void;
};

type ImportServerVideoResponse = {
  uploadId: string;
  status: 'uploading' | 'uploaded' | 'processing' | 'ready' | 'failed';
  uploadedBytes: number;
  totalBytes: number;
  chunkSizeBytes: number;
  sourceDurationSec?: number | null;
  previewVideo?: {
    url: string;
    width: number;
    height: number;
    posterPath?: string | null;
    posterUrl?: string | null;
  } | null;
};

type ApiErrorResponse = {
  error?: string;
  path?: string;
  phase?: string;
};

const LOG_PREFIX = '[ServerImport]';
const IMPORT_ENDPOINT = '/api/uploads/import';
const IMPORT_REQUEST_TIMEOUT_MS = 60000;
const RESPONSE_PREVIEW_CHARS = 240;

function log(...args: unknown[]) {
  console.log(LOG_PREFIX, new Date().toISOString(), ...args);
}

function logError(...args: unknown[]) {
  console.error(LOG_PREFIX, new Date().toISOString(), ...args);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

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

function buildResponseError(
  endpoint: string,
  response: Response,
  bodyText: string,
  action: string,
): Error {
  const contentType = response.headers.get('content-type') ?? 'unknown';

  if (bodyText.trim().length > 0) {
    try {
      const body = JSON.parse(bodyText) as ApiErrorResponse;
      if (body.error != null && body.error.trim().length > 0) {
        const parts = [body.error.trim()];
        if (body.phase) parts.unshift(`phase=${body.phase}`);
        if (body.path && !parts.some(p => p.includes(body.path ?? ''))) {
          parts.push(`path=${body.path}`);
        }
        return new Error(`${action}: ${parts.join('. ')}`);
      }
    } catch {
      // not JSON, fall through
    }
  }

  if (contentType.includes('text/html')) {
    return new Error(
      `${action}: ${endpoint} returned HTML (status ${response.status}). ` +
      'Vite proxy may not be forwarding this API request to the backend.',
    );
  }

  const preview = summarizeBodyText(bodyText);
  return new Error(
    `${action}: status ${response.status}` +
    (preview ? `, body: ${preview}` : ''),
  );
}

async function importFetch(
  path: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<ImportServerVideoResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  const abortFromExternal = () => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', abortFromExternal);
  }

  try {
    log('Fetching', IMPORT_ENDPOINT, 'path=', path);

    const response = await fetch(IMPORT_ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path}),
      signal: controller.signal,
    });

    const bodyText = await response.text();
    log('Response received: status=', response.status, 'length=', bodyText.length);

    if (!response.ok) {
      throw buildResponseError(IMPORT_ENDPOINT, response, bodyText, 'Import');
    }

    if (!isJsonContentType(response.headers.get('content-type'))) {
      throw new Error(
        `Import: expected JSON, got ${response.headers.get('content-type')} (status ${response.status})`,
      );
    }

    return JSON.parse(bodyText) as ImportServerVideoResponse;
  } finally {
    window.clearTimeout(timeoutId);
    signal.removeEventListener('abort', abortFromExternal);
  }
}

export default function useImportServerVideo({onUpload}: Props) {
  const [error, setError] = useState<string | null>(null);
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [phaseDetail, setPhaseDetail] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const mountedRef = useRef(true);
  const importControllerRef = useRef<AbortController | null>(null);
  const elapsedTimerRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const {clearUploadSession} = useUploadSession();
  const setUploadSession = useSetAtom(uploadSessionAtom);
  const setUploadingState = useSetAtom(uploadingStateAtom);

  const stopTimer = useCallback(() => {
    if (elapsedTimerRef.current != null) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    startTimeRef.current = Date.now();
    setElapsedMs(0);
    elapsedTimerRef.current = window.setInterval(() => {
      if (mountedRef.current) {
        setElapsedMs(Date.now() - startTimeRef.current);
      }
    }, 200);
  }, [stopTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopTimer();
    };
  }, [stopTimer]);

  const setStatus = useCallback((p: string, detail: string) => {
    log(p, '|', detail);
    if (mountedRef.current) {
      setPhase(p);
      setPhaseDetail(detail);
    }
  }, []);

  const cancelImport = useCallback(() => {
    log('Cancel requested');
    importControllerRef.current?.abort();
    importControllerRef.current = null;
    stopTimer();
    if (mountedRef.current) {
      setError('Import cancelled by user.');
      setLoadingPath(null);
      setPhase(null);
      setPhaseDetail(null);
      setElapsedMs(0);
    }
  }, [stopTimer]);

  const importVideo = useCallback(
    async (path: string) => {
      log('=== importVideo START ===', path);

      // Abort previous import if any
      importControllerRef.current?.abort();
      const controller = new AbortController();
      importControllerRef.current = controller;

      // Reset UI state
      setError(null);
      startTimer();
      setPhase('Step 1/4: Clearing previous session...');
      setPhaseDetail('Removing previous local preview.');
      setLoadingPath(path);

      try {
        // === Step 1: Clear previous session (non-blocking, with safety timeout) ===
        log('Step 1: clearUploadSession()...');
        try {
          await clearUploadSession();
          log('Step 1: done');
        } catch (clearErr) {
          log('Step 1: clearUploadSession threw, ignoring:', clearErr);
        }

        if (!mountedRef.current || controller.signal.aborted) {
          log('Aborted after step 1');
          return;
        }

        // === Step 2: Send import request to backend ===
        setStatus(
          'Step 2/4: Sending import request...',
          `POST ${IMPORT_ENDPOINT} with path=${path}`,
        );

        const importedVideo = await importFetch(
          path,
          controller.signal,
          IMPORT_REQUEST_TIMEOUT_MS,
        );

        if (!mountedRef.current || controller.signal.aborted) {
          log('Aborted after step 2');
          return;
        }

        const elapsed = Date.now() - startTimeRef.current;
        log('Step 2: got response in', elapsed, 'ms:', {
          uploadId: importedVideo.uploadId,
          status: importedVideo.status,
          previewVideo: importedVideo.previewVideo != null,
          sourceDurationSec: importedVideo.sourceDurationSec,
        });

        // === Step 3: Validate and build preview session ===
        setStatus(
          'Step 3/4: Building preview session...',
          `uploadId=${importedVideo.uploadId} | status=${importedVideo.status} | responded in ${elapsed}ms`,
        );

        if (
          importedVideo.previewVideo == null ||
          importedVideo.sourceDurationSec == null ||
          importedVideo.sourceDurationSec <= 0
        ) {
          throw new Error(
            `Backend returned incomplete metadata: ` +
            `previewVideo=${importedVideo.previewVideo != null}, ` +
            `sourceDurationSec=${importedVideo.sourceDurationSec}`,
          );
        }

        const sessionController = new AbortController();
        const previewVideo = createPreviewVideoData({
          url: importedVideo.previewVideo.url,
          width: importedVideo.previewVideo.width,
          height: importedVideo.previewVideo.height,
          posterPath: importedVideo.previewVideo.posterPath,
          posterUrl: importedVideo.previewVideo.posterUrl,
        });
        const sourceDurationSec = Math.ceil(importedVideo.sourceDurationSec);
        const session: UploadSession = {
          uploadId: importedVideo.uploadId,
          status: importedVideo.status === 'uploaded' ? 'uploaded' : 'uploading',
          uploadedBytes: importedVideo.uploadedBytes,
          totalBytes: importedVideo.totalBytes,
          chunkSizeBytes: importedVideo.chunkSizeBytes,
          objectUrl: importedVideo.previewVideo.url,
          shouldRevokeObjectUrl: false,
          controller: sessionController,
          previewVideo,
          readyVideo: null,
          error: null,
          sourceDurationSec,
          selectedStartTimeSec: 0,
          selectedEndTimeSec: Math.max(
            1,
            Math.min(sourceDurationSec, MAX_UPLOAD_VIDEO_DURATION_SECONDS),
          ),
        };

        log('Step 3: preview session built', {
          w: importedVideo.previewVideo.width,
          h: importedVideo.previewVideo.height,
          dur: sourceDurationSec,
          size: importedVideo.totalBytes,
        });

        // === Step 4: Store session and navigate to preview ===
        setStatus(
          'Step 4/4: Opening preview...',
          `${importedVideo.previewVideo.width}x${importedVideo.previewVideo.height}, ` +
          `${Math.round(importedVideo.sourceDurationSec)}s, ` +
          `${(importedVideo.totalBytes / 1048576).toFixed(1)}MB`,
        );

        setUploadSession(session);
        setUploadingState(session.status === 'uploaded' ? 'uploaded' : 'uploading');
        log('Step 4: calling onUpload to navigate to preview...');
        stopTimer();
        onUpload(previewVideo);
        log('=== importVideo SUCCESS ===');
      } catch (err) {
        stopTimer();
        if (controller.signal.aborted && isAbortError(err)) {
          log('Import aborted (expected)');
          return;
        }
        const totalMs = Date.now() - startTimeRef.current;
        logError('=== importVideo FAILED ===', `after ${totalMs}ms`, err);
        if (mountedRef.current) {
          const errMsg = err instanceof Error ? err.message : String(err);
          setPhase(`Import failed (${(totalMs / 1000).toFixed(1)}s)`);
          setPhaseDetail(errMsg);
          setError(`${path}: ${errMsg}`);
        }
      } finally {
        stopTimer();
        setLoadingPath(null);
        if (importControllerRef.current === controller) {
          importControllerRef.current = null;
        }
        log('=== importVideo END ===');
      }
    },
    [
      clearUploadSession,
      onUpload,
      setUploadSession,
      setUploadingState,
      setStatus,
      startTimer,
      stopTimer,
    ],
  );

  const clearError = useCallback(() => {
    setError(null);
    setPhaseDetail(null);
  }, []);

  return {
    error,
    loadingPath,
    phase,
    phaseDetail,
    elapsedMs,
    importVideo,
    cancelImport,
    clearError,
  };
}
