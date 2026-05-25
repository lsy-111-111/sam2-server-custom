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
import CreateFilmstripError from '@/graphql/errors/CreateFilmstripError';
import DrawFrameError from '@/graphql/errors/DrawFrameError';
import WebGLContextError from '@/graphql/errors/WebGLContextError';
import {deserializeError, type ErrorObject} from 'serialize-error';

export type RenderingErrorType =
  | 'webgl_context'
  | 'draw_frame'
  | 'create_filmstrip'
  | 'error';

function normalizeError(error?: Error | ErrorObject | null): Error | null {
  if (error == null) {
    return null;
  }
  return error instanceof Error ? error : deserializeError(error);
}

export function getRenderErrorType(
  error?: Error | ErrorObject | null,
): RenderingErrorType {
  const deserializedError = normalizeError(error);

  if (deserializedError instanceof WebGLContextError) {
    return 'webgl_context';
  }
  if (deserializedError instanceof DrawFrameError) {
    return 'draw_frame';
  }
  if (deserializedError instanceof CreateFilmstripError) {
    return 'create_filmstrip';
  }
  return 'error';
}

export function getErrorMessage(
  error?: Error | ErrorObject | null,
): string | null {
  const normalizedError = normalizeError(error);
  const message = normalizedError?.message?.trim();
  return message != null && message.length > 0 ? message : null;
}

export function getErrorName(error?: Error | ErrorObject | null): string | null {
  const normalizedError = normalizeError(error);
  const name = normalizedError?.name?.trim();
  return name != null && name.length > 0 ? name : null;
}

export function getErrorSummary(error?: Error | ErrorObject | null): string {
  const name = getErrorName(error);
  const message = getErrorMessage(error);

  if (name != null && message != null && message !== name) {
    return `${name}: ${message}`;
  }
  return message ?? name ?? 'Unknown error';
}

export function getRenderErrorSummary(
  error?: Error | ErrorObject | null,
): string {
  switch (getRenderErrorType(error)) {
    case 'webgl_context':
      return (
        getErrorMessage(error) ??
        'The browser could not create a WebGL2 context for the video renderer.'
      );
    case 'draw_frame':
      return (
        getErrorMessage(error) ??
        'The browser failed while drawing a decoded video frame.'
      );
    case 'create_filmstrip':
      return (
        getErrorMessage(error) ??
        'The browser failed while building the filmstrip preview.'
      );
    default:
      return getErrorSummary(error);
  }
}

/**
 * This function extracts the title from an error message.
 * The title is defined as the text before the first newline character.
 *
 * @param error The error object from which the title is to be extracted.
 * @returns The title of the error message.
 * @example
 * ```ts
 * const error = new Error('This is the title\nThis is the body');
 * const title = getErrorTitle(error);
 * console.log(title); // 'This is the title'
 * ```
 */
export function getErrorTitle({message}: Error): string {
  const idx = message.indexOf('\n');
  return idx < 0 ? message : message.substring(0, idx);
}
