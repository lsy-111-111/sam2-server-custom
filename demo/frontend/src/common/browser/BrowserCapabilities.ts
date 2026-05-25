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
export type BrowserSupportIssue = {
  title: string;
  description: string;
  reason: string;
};

const REQUIRED_WINDOW_APIS = ['VideoEncoder', 'VideoDecoder', 'VideoFrame'];

export function canUseWorkerWebGL2(): boolean {
  if (typeof OffscreenCanvas !== 'function') {
    return false;
  }

  try {
    return new OffscreenCanvas(1, 1).getContext('webgl2') != null;
  } catch {
    return false;
  }
}

export function getBrowserSupportIssue(): BrowserSupportIssue | null {
  const missingWindowApis = REQUIRED_WINDOW_APIS.filter(api => !(api in window));
  if (missingWindowApis.length > 0) {
    return {
      title: 'Uh oh, this browser is missing required video APIs.',
      description:
        'This demo relies on modern browser video APIs that are not available in the current browser.',
      reason: `Missing browser APIs: ${missingWindowApis.join(', ')}`,
    };
  }

  if (typeof OffscreenCanvas !== 'function') {
    return {
      title: 'This browser cannot create offscreen canvases.',
      description:
        'The demo renders video frames inside a worker, which requires OffscreenCanvas support.',
      reason: 'Missing browser API: OffscreenCanvas',
    };
  }

  const canvas = document.createElement('canvas');
  if (typeof canvas.transferControlToOffscreen !== 'function') {
    return {
      title: 'This browser cannot hand the canvas to the video worker.',
      description:
        'The demo needs transferControlToOffscreen to render video frames off the main thread.',
      reason: 'Missing browser API: HTMLCanvasElement.transferControlToOffscreen',
    };
  }

  try {
    const offscreenCanvas = new OffscreenCanvas(1, 1);
    if (offscreenCanvas.getContext('2d') == null) {
      return {
        title: 'This browser cannot create an OffscreenCanvas 2D context.',
        description:
          'The video worker could not initialize its drawing surface, so the editor cannot render frames.',
        reason: 'OffscreenCanvas.getContext("2d") returned null',
      };
    }
  } catch (error) {
    return {
      title: 'This browser cannot initialize the offscreen renderer.',
      description:
        'The demo could not create the worker rendering canvas needed for video playback.',
      reason:
        error instanceof Error && error.message.length > 0
          ? error.message
          : 'Unknown OffscreenCanvas initialization error',
    };
  }

  return null;
}
