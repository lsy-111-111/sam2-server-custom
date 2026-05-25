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
import useImportServerVideo from '@/common/components/gallery/useImportServerVideo';
import {VideoData} from '@/demo/atoms';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {Loading} from 'react-daisyui';

type Props = {
  onBack: () => void;
  onImport: (video: VideoData) => void;
};

type ServerFileEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  sizeBytes?: number;
};

type ServerFileBrowserResponse = {
  rootPath: string;
  currentPath: string;
  parentPath: string | null;
  entries: ServerFileEntry[];
};

const SERVER_FILES_ENDPOINT = '/api/server-files';
const RESPONSE_PREVIEW_CHARS = 240;

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
      `${action} failed: ${endpoint} returned HTML instead of JSON (status ${response.status}). The frontend likely served index.html instead of proxying /api/server-files to the backend.`,
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

  if ((response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
    return new Error(
      `${action} failed: ${endpoint} returned HTML with status ${response.status}. The frontend likely served index.html instead of proxying /api/server-files to the backend.`,
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

function getBrowserErrorMessage(
  error: unknown,
  requestedPath: string | null,
): string {
  const pathLabel = requestedPath ?? '(server root)';
  if (error instanceof Error && error.message.trim().length > 0) {
    return `Could not browse ${pathLabel}. ${error.message}`;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return `Could not browse ${pathLabel}. ${error}`;
  }
  return `Could not browse ${pathLabel}.`;
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  action: string = 'Directory request',
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

function formatBytes(bytes?: number): string {
  if (bytes == null || bytes <= 0) {
    return '--';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatElapsedTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSec}s`;
}

export default function ServerVideoBrowser({onBack, onImport}: Props) {
  const [browserData, setBrowserData] =
    useState<ServerFileBrowserResponse | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [isLoadingDirectory, setIsLoadingDirectory] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const {
    error: importError,
    loadingPath,
    phase,
    phaseDetail,
    elapsedMs,
    importVideo,
    cancelImport,
    clearError: clearImportError,
  } = useImportServerVideo({onUpload: onImport});

  const loadDirectory = useCallback(
    async (path: string | null, signal?: AbortSignal) => {
      setIsLoadingDirectory(true);
      setBrowserError(null);

      try {
        const query = path != null ? `?path=${encodeURIComponent(path)}` : '';
        const response = await requestJson<ServerFileBrowserResponse>(
          `${SERVER_FILES_ENDPOINT}${query}`,
          {signal},
          'Directory request',
        );
        setBrowserData(response);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setBrowserError(getBrowserErrorMessage(error, path));
      } finally {
        setIsLoadingDirectory(false);
      }
    },
    [],
  );

  useEffect(() => {
    clearImportError();
    const controller = new AbortController();
    void loadDirectory(currentPath, controller.signal);
    return () => controller.abort();
  }, [clearImportError, currentPath, loadDirectory]);

  const breadcrumbs = useMemo(() => {
    if (browserData == null) {
      return [];
    }

    const {rootPath, currentPath: activePath} = browserData;
    if (rootPath === activePath) {
      return [{label: rootPath, path: rootPath}];
    }

    const normalizedRoot = rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '');
    const relativePath = activePath
      .slice(normalizedRoot.length)
      .replace(/^\/+/, '');
    const segments = relativePath.split('/').filter(Boolean);
    const crumbs = [{label: normalizedRoot, path: normalizedRoot}];

    let nextPath = normalizedRoot === '/' ? '' : normalizedRoot;
    segments.forEach(segment => {
      nextPath =
        nextPath === '' || nextPath === '/'
          ? `/${segment}`
          : `${nextPath}/${segment}`;
      crumbs.push({label: segment, path: nextPath});
    });

    return crumbs;
  }, [browserData]);

  const emptyState =
    !isLoadingDirectory &&
    browserError == null &&
    browserData != null &&
    browserData.entries.length === 0;
  const activeImportPhase = phase ?? 'Initializing import...';
  const activeImportDetail =
    phaseDetail ?? 'Preparing to send request to the backend.';

  return (
    <div className="flex h-full flex-col px-4 pb-6 pt-2 md:px-16 md:pt-8">
      <div className="mb-5 flex items-center justify-between gap-4">
        <div>
          <h3 className="mb-2 text-2xl font-medium text-white">
            Select from server
          </h3>
          <p className="text-sm leading-6 text-gray-400 md:text-base">
            Browse server folders and import a video into preview mode.
          </p>
        </div>
        <button
          type="button"
          className="rounded-lg border border-white/15 px-3 py-2 text-sm font-medium text-white transition hover:border-white/40 hover:bg-white/5"
          onClick={onBack}>
          Back to gallery
        </button>
      </div>

      <div className="mb-4 overflow-x-auto rounded-xl border border-white/10 bg-black/20 px-4 py-3">
        <div className="mb-2 text-[11px] uppercase tracking-[0.18em] text-gray-500">
          Current path
        </div>
        <div className="flex min-w-max flex-wrap items-center gap-2 text-sm text-gray-200">
          {breadcrumbs.map((crumb, index) => (
            <div key={crumb.path} className="flex items-center gap-2">
              {index > 0 && <span className="text-gray-500">/</span>}
              <button
                type="button"
                className="rounded px-2 py-1 font-mono text-left transition hover:bg-white/5 hover:text-white"
                onClick={() => setCurrentPath(crumb.path)}>
                {crumb.label}
              </button>
            </div>
          ))}
        </div>
      </div>

      {browserError != null && (
        <div className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-100">
          {browserError}
        </div>
      )}

      {importError != null && (
        <div className="mb-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-100">
          {importError}
        </div>
      )}

      {loadingPath != null && (
        <div className="mb-4 rounded-xl border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 text-sm leading-6 text-cyan-50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="text-[11px] uppercase tracking-[0.18em] text-cyan-200/70">
                Import progress
              </div>
              <div className="rounded bg-cyan-400/20 px-2 py-0.5 font-mono text-xs text-cyan-200">
                {formatElapsedTime(elapsedMs)}
              </div>
            </div>
            <button
              type="button"
              className="rounded-md border border-cyan-400/30 px-3 py-1 text-xs font-medium text-cyan-200 transition hover:border-red-400/50 hover:bg-red-500/20 hover:text-red-200"
              onClick={cancelImport}>
              Cancel
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Loading size="xs" />
            <span className="break-words font-medium">{activeImportPhase}</span>
          </div>
          <div className="mt-1 break-all font-mono text-xs text-cyan-100/60">{loadingPath}</div>
          <div className="mt-2 break-words text-cyan-100/80">
            {activeImportDetail}
          </div>
          {elapsedMs > 10000 && (
            <div className="mt-2 rounded border border-yellow-400/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
              Request is taking longer than expected ({formatElapsedTime(elapsedMs)}).
              Backend may be busy probing video metadata. If stuck, click Cancel and retry.
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-black/10">
        {isLoadingDirectory ? (
          <div className="flex h-full items-center justify-center gap-3 text-gray-300">
            <Loading />
            <span>Loading server directory...</span>
          </div>
        ) : emptyState ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm leading-6 text-gray-400">
            No folders or supported videos were found in this directory.
          </div>
        ) : (
          <div className="h-full overflow-y-auto">
            {browserData?.parentPath != null && (
              <button
                type="button"
                className="flex w-full items-center justify-between border-b border-white/5 px-4 py-4 text-left transition hover:bg-white/5"
                onClick={() => setCurrentPath(browserData.parentPath)}>
                <div>
                  <div className="text-sm font-medium text-white">..</div>
                  <div className="mt-1 text-xs text-gray-500">
                    Parent directory
                  </div>
                </div>
                <span className="text-xs uppercase tracking-[0.18em] text-gray-500">
                  folder
                </span>
              </button>
            )}

            {browserData?.entries.map(entry => {
              const isImporting = loadingPath === entry.path;
              return (
                <button
                  key={entry.path}
                  type="button"
                  className="flex w-full items-center justify-between border-b border-white/5 px-4 py-4 text-left transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={loadingPath != null}
                  onClick={() => {
                    if (entry.type === 'directory') {
                      clearImportError();
                      setCurrentPath(entry.path);
                      return;
                    }

                    void importVideo(entry.path);
                  }}>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-white">
                      {entry.name}
                    </div>
                    <div className="mt-1 truncate text-xs text-gray-500">
                      {entry.path}
                    </div>
                  </div>
                  <div className="ml-4 shrink-0 text-right">
                    {isImporting ? (
                      <div className="max-w-[360px] text-right text-sm text-gray-200">
                        <div className="flex items-center justify-end gap-2">
                          <Loading size="sm" />
                          <span className="font-mono text-xs text-cyan-300">{formatElapsedTime(elapsedMs)}</span>
                        </div>
                        <div className="mt-1 text-xs text-gray-400">
                          {activeImportPhase}
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="text-xs uppercase tracking-[0.18em] text-gray-500">
                          {entry.type === 'directory' ? 'folder' : 'video'}
                        </div>
                        {entry.type === 'file' && (
                          <div className="mt-1 text-xs text-gray-400">
                            {formatBytes(entry.sizeBytes)}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
