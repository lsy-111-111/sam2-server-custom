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

export function normalizeFrameListFileName(fileName: string): string {
  const normalizedFileName = fileName.trim();
  return normalizedFileName.length > 0 ? normalizedFileName : 'frame_list.txt';
}

export function validateFrameListIndices(
  frameIndices: number[],
  totalFrames?: number,
): number[] {
  if (!Array.isArray(frameIndices) || frameIndices.length === 0) {
    throw new Error('Frame list txt must contain at least one frame index.');
  }

  const normalizedTotalFrames =
    totalFrames != null && Number.isFinite(totalFrames)
      ? Math.floor(totalFrames)
      : null;
  const seenFrameIndices = new Set<number>();

  for (const frameIndex of frameIndices) {
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) {
      throw new Error('Frame list entries must be non-negative integers.');
    }
    if (seenFrameIndices.has(frameIndex)) {
      throw new Error(
        `Frame list contains duplicate frame index ${frameIndex}.`,
      );
    }
    if (normalizedTotalFrames != null && frameIndex >= normalizedTotalFrames) {
      const maxFrameIndex = Math.max(0, normalizedTotalFrames - 1);
      throw new Error(
        `Frame list index ${frameIndex} is outside the video range 0-${maxFrameIndex}.`,
      );
    }
    seenFrameIndices.add(frameIndex);
  }

  return [...frameIndices];
}

export function parseFrameListText(
  text: string,
  totalFrames: number,
): number[] {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    throw new Error(
      'Could not determine the video frame count for frame list export.',
    );
  }

  const frameIndices: number[] = [];
  const seenFrameIndices = new Set<number>();
  const maxFrameIndex = Math.max(0, Math.floor(totalFrames) - 1);

  text.split(/\r?\n/).forEach((line, lineIndex) => {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    if (!/^\d+$/.test(trimmedLine)) {
      throw new Error(
        `Frame list line ${lineIndex + 1} must contain one non-negative integer.`,
      );
    }

    const frameIndex = Number(trimmedLine);
    if (!Number.isSafeInteger(frameIndex)) {
      throw new Error(`Frame list line ${lineIndex + 1} is too large.`);
    }
    if (seenFrameIndices.has(frameIndex)) {
      throw new Error(
        `Frame list contains duplicate frame index ${frameIndex}.`,
      );
    }
    if (frameIndex > maxFrameIndex) {
      throw new Error(
        `Frame list index ${frameIndex} is outside the video range 0-${maxFrameIndex}.`,
      );
    }

    seenFrameIndices.add(frameIndex);
    frameIndices.push(frameIndex);
  });

  if (frameIndices.length === 0) {
    throw new Error('Frame list txt must contain at least one frame index.');
  }

  return frameIndices;
}
