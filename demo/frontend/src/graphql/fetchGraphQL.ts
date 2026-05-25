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
import Logger from '@/common/logger/Logger';
import {
  CacheConfig,
  GraphQLResponse,
  RequestParameters,
  UploadableMap,
  Variables,
} from 'relay-runtime';

const RESPONSE_PREVIEW_LIMIT = 300;

const DEFAULT_GRAPHQL_TIMEOUT_MS = 30000;

function getGraphQLTimeoutMs(): number {
  const rawValue = import.meta.env.VITE_GRAPHQL_TIMEOUT_MS;
  const parsedValue = rawValue == null ? NaN : Number(rawValue);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : DEFAULT_GRAPHQL_TIMEOUT_MS;
}

function getResponseDetails(response: Response): string {
  const statusText = response.statusText || 'Unknown Status';
  const contentType = response.headers.get('content-type') ?? 'unknown type';
  return `${response.status} ${statusText} (${contentType})`;
}

function getResponsePreview(text: string): string {
  const preview = text.trim();
  if (preview.length <= RESPONSE_PREVIEW_LIMIT) {
    return preview;
  }
  return `${preview.slice(0, RESPONSE_PREVIEW_LIMIT)}...`;
}

async function parseGraphQLResponse(
  url: string,
  response: Response,
): Promise<GraphQLResponse> {
  const text = await response.text();
  const details = getResponseDetails(response);

  if (text.trim().length === 0) {
    throw new Error(
      `GraphQL endpoint ${url} returned ${details} with an empty response ` +
        'body. If you are using the Vite dev server, make sure the backend ' +
        'is running and reachable at the proxy target, usually ' +
        'http://127.0.0.1:7263',
    );
  }

  try {
    return JSON.parse(text) as GraphQLResponse;
  } catch {
    const preview = getResponsePreview(text);
    throw new Error(
      `GraphQL endpoint ${url} returned ${details}, but the body was not ` +
        `valid JSON. Response preview: ${preview}`,
    );
  }
}

/**
 * Inspired by https://github.com/facebook/relay/issues/1844
 */
export default async function fetchGraphQL(
  endpoint: string,
  request: RequestParameters,
  variables: Variables,
  cacheConfig: CacheConfig,
  uploadables?: UploadableMap | null,
): Promise<GraphQLResponse> {
  const url = `${endpoint}/graphql`;

  const headers: {[name: string]: string} = {};
  const requestInit: RequestInit = {
    method: 'POST',
    headers,
    credentials: 'include',
  };

  const customHeaders = (cacheConfig?.metadata?.headers ?? {}) as {
    [key: string]: string;
  };

  requestInit.headers = Object.assign(customHeaders, requestInit.headers);

  if (uploadables != null) {
    const formData = new FormData();
    formData.append(
      'operations',
      JSON.stringify({
        query: request.text,
        variables,
      }),
    );

    const uploadableMap: {
      [key: string]: string[];
    } = {};

    Object.keys(uploadables).forEach(key => {
      uploadableMap[key] = [`variables.${key}`];
    });

    formData.append('map', JSON.stringify(uploadableMap));

    Object.keys(uploadables).forEach(key => {
      formData.append(key, uploadables[key]);
    });

    requestInit.body = formData;
  } else {
    requestInit.headers = Object.assign(
      {'Content-Type': 'application/json'},
      requestInit.headers,
    );

    requestInit.body = JSON.stringify({
      query: request.text,
      variables,
    });
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    getGraphQLTimeoutMs(),
  );
  requestInit.signal = abortController.signal;

  try {
    const response = await fetch(url, requestInit);
    const result = await parseGraphQLResponse(url, response);

    // Handle any intentional GraphQL errors, which are passed through the
    // errors property in the JSON payload.
    if (result != null && typeof result === 'object' && 'errors' in result) {
      for (const error of result.errors ?? []) {
        Logger.error(error);
      }
    }

    return result;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      const timeoutError = new Error(
        `GraphQL endpoint ${url} did not respond within ${getGraphQLTimeoutMs()}ms`,
      );
      Logger.error(timeoutError);
      throw timeoutError;
    }
    Logger.error(`Could not connect to GraphQL endpoint ${url}`, error);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
