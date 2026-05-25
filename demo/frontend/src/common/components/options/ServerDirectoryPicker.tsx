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
import {useCallback, useEffect, useMemo, useState} from 'react';
import {Loading} from 'react-daisyui';

type Props = {
  initialPath?: string | null;
  onCancel: () => void;
  onConfirm: (path: string) => void;
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

  if ((response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
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

export default function ServerDirectoryPicker({
  initialPath = null,
  onCancel,
  onConfirm,
}: Props) {
  const [browserData, setBrowserData] =
    useState<ServerFileBrowserResponse | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [isLoadingDirectory, setIsLoadingDirectory] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath);

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
    setCurrentPath(initialPath);
  }, [initialPath]);

  useEffect(() => {
    const controller = new AbortController();
    void loadDirectory(currentPath, controller.signal);
    return () => controller.abort();
  }, [currentPath, loadDirectory]);

  const directories = useMemo(
    () =>
      (browserData?.entries ?? []).filter(entry => entry.type === 'directory'),
    [browserData],
  );

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

  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-black/30 p-4 text-white">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-base font-medium">Choose server folder</div>
          <div className="text-sm text-gray-300">
            Browse directories and confirm the folder where the annotation JSON
            should be written.
          </div>
        </div>
        <button
          type="button"
          className="rounded-full border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/10"
          onClick={onCancel}>
          Close picker
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs text-gray-300">
        {breadcrumbs.map(crumb => (
          <button
            key={crumb.path}
            type="button"
            className="rounded-full border border-white/10 px-3 py-1 hover:bg-white/10"
            onClick={() => setCurrentPath(crumb.path)}>
            {crumb.label}
          </button>
        ))}
      </div>

      {browserError != null && (
        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-100">
          {browserError}
        </div>
      )}

      {isLoadingDirectory && (
        <div className="mt-4 flex items-center gap-3 text-sm text-gray-200">
          <Loading size="sm" />
          Loading server directory...
        </div>
      )}

      {!isLoadingDirectory && browserData != null && (
        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-gray-200">
            Current folder: <span className="font-mono text-white">{browserData.currentPath}</span>
          </div>

          {browserData.parentPath != null && (
            <button
              type="button"
              className="w-full rounded-lg border border-white/10 px-4 py-3 text-left text-sm text-white hover:bg-white/10"
              onClick={() => setCurrentPath(browserData.parentPath)}>
              ..
            </button>
          )}

          {directories.length === 0 ? (
            <div className="rounded-lg border border-white/10 bg-black/20 p-4 text-sm text-gray-300">
              This folder does not contain any subdirectories.
            </div>
          ) : (
            <div className="grid gap-2">
              {directories.map(directory => (
                <button
                  key={directory.path}
                  type="button"
                  className="w-full rounded-lg border border-white/10 px-4 py-3 text-left text-sm text-white hover:bg-white/10"
                  onClick={() => setCurrentPath(directory.path)}>
                  {directory.name}
                  <div className="mt-1 font-mono text-xs text-gray-400">
                    {directory.path}
                  </div>
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-3 pt-2">
            <button
              type="button"
              className="rounded-full border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/10"
              onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="rounded-full bg-white px-4 py-2 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
              disabled={browserData == null}
              onClick={() => {
                if (browserData != null) {
                  onConfirm(browserData.currentPath);
                }
              }}>
              Use this folder
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
