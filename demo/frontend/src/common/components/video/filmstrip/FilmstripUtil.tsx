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
import {TrimRange} from '@/demo/atoms';
import {CanvasForm, CanvasSpace, Font, Group, Pt, Triangle} from 'pts';
import SelectedFrameHelper from './SelectedFrameHelper';
import {PADDING_BOTTOM, PADDING_TOP} from './VideoFilmstrip';

export function getPointerPosition(
  event: React.PointerEvent<HTMLCanvasElement>,
) {
  const rect = event.currentTarget.getBoundingClientRect();
  return new Pt(event.clientX - rect.left, event.clientY - rect.top);
}

export function drawFilmstrip(
  filmstrip: ImageBitmap | null,
  space: CanvasSpace | undefined,
  form: CanvasForm | undefined,
) {
  if (filmstrip == null || space == undefined || form?.ctx == undefined) {
    return;
  }

  const ratio =
    filmstrip.width / (filmstrip.height + PADDING_TOP + PADDING_BOTTOM);

  form.image(
    [
      [0, PADDING_TOP],
      [space.size.x, space.size.x / ratio],
    ],
    filmstrip,
  );
}

export function getTimeFromFrame(frame: number, fps: number): string {
  const normalizedFrame = Math.max(0, Math.floor(frame));
  const normalizedFps = Math.max(1, fps);
  const totalSeconds = Math.floor(normalizedFrame / normalizedFps);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frameRemaining = normalizedFrame - Math.floor(totalSeconds * normalizedFps);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(
    frameRemaining,
  ).padStart(2, '0')}`;
}

export function drawTrimRange(
  space: CanvasSpace | undefined,
  form: CanvasForm | undefined,
  selectedFrameHelper: SelectedFrameHelper,
  trimRange: TrimRange,
  fps: number,
) {
  if (space == undefined || form?.ctx == undefined) {
    return;
  }

  const ctx = form.ctx;
  const startX = selectedFrameHelper.toPosition(trimRange.startFrame);
  const endX = selectedFrameHelper.toPosition(trimRange.endFrameExclusive);
  const top = PADDING_TOP;
  const bottom = space.height - PADDING_BOTTOM;
  const height = bottom - top;

  ctx.save();
  ctx.fillStyle = '#00000099';
  ctx.fillRect(
    Math.min(space.width, endX),
    top,
    Math.max(0, space.width - endX),
    height,
  );
  ctx.strokeStyle = '#6EE7F9';
  ctx.lineWidth = 2;
  ctx.strokeRect(startX, top + 1, Math.max(1, endX - startX), height - 2);
  ctx.fillStyle = '#6EE7F9';
  ctx.fillRect(endX - 2, top, 4, height);
  ctx.font = '12px monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('0:00.00', Math.max(0, startX + 6), 12);
  const endLabel = getTimeFromFrame(Math.max(0, trimRange.endFrameExclusive - 1), fps);
  const endWidth = ctx.measureText(endLabel).width;
  ctx.fillText(endLabel, Math.min(space.width - endWidth, Math.max(0, endX - endWidth - 6)), 12);
  ctx.restore();
}

export function drawMarker(
  space: CanvasSpace | undefined,
  form: CanvasForm | undefined,
  selectedFrameHelper: SelectedFrameHelper,
  pointerPosition: Pt | null,
  scanLabel: string | false,
  fps: number,
) {
  if (space == undefined || form?.ctx == undefined) {
    return;
  }

  const marker = Group.fromArray([
    [0, PADDING_TOP],
    [0, space.height - PADDING_BOTTOM],
  ]);

  const currentMarker = marker
    .clone()
    .add(Math.max(5, selectedFrameHelper.position), 0);

  const getTextPosition = (label: string, marker: Group) => {
    const textWidth = form.ctx.measureText(label).width;
    return marker[0]
      .$subtract(textWidth / 2, 0)
      .$min(space.width - textWidth, PADDING_TOP - 10)
      .$max(textWidth / 2 - 2, 0);
  };

  form
    .strokeOnly('#00000066', 5)
    .line(currentMarker)
    .strokeOnly('#fff', 1)
    .line(currentMarker)
    .fill('#000')
    .polygon(
      Triangle.fromCenter(currentMarker[0].$add(0, 10), 5).rotate2D(Math.PI),
    );

  const frameLabel = getTimeFromFrame(selectedFrameHelper.index, fps);
  form
    .font(new Font(12, 'monospace'))
    .fillOnly('#fff')
    .text(getTextPosition(frameLabel, currentMarker), frameLabel);

  if (
    selectedFrameHelper.isScanning &&
    pointerPosition != null &&
    scanLabel != false
  ) {
    const scanMarker = marker.clone().add(pointerPosition.x, 0);
    form.strokeOnly('#ffffff66', 5).line(scanMarker);

    form
      .font(new Font(12, 'monospace'))
      .fillOnly('#8595A4')
      .text(getTextPosition(scanLabel, scanMarker), scanLabel);
  }
}
