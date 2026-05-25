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
import {MAX_UPLOAD_VIDEO_DURATION_SECONDS} from '@/demo/DemoConfig';
import {useEffect, useMemo, useState} from 'react';

type Props = {
  sourceDurationSec: number;
  selectedStartTimeSec: number;
  selectedEndTimeSec: number;
  isSelectionLocked: boolean;
  onSelectSegment: (startTimeSec: number, endTimeSec: number) => void;
};

type Segment = {
  index: number;
  startTimeSec: number;
  endTimeSec: number;
};

const SHORT_VIDEO_SEGMENT_SECONDS = 60;

function formatDuration(totalSeconds: number): string {
  const normalizedSeconds = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(normalizedSeconds / 3600);
  const minutes = Math.floor((normalizedSeconds % 3600) / 60);
  const seconds = normalizedSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function getDefaultSegmentCount(sourceDurationSec: number): number {
  return Math.max(
    1,
    Math.ceil(sourceDurationSec / MAX_UPLOAD_VIDEO_DURATION_SECONDS),
  );
}

function clampSegmentCount(
  segmentCount: number,
  sourceDurationSec: number,
  minimumSegmentCount: number,
): number {
  if (!Number.isFinite(segmentCount)) {
    return minimumSegmentCount;
  }

  return Math.min(
    sourceDurationSec,
    Math.max(minimumSegmentCount, Math.round(segmentCount)),
  );
}

function buildEqualSegments(
  sourceDurationSec: number,
  segmentCount: number,
): Segment[] {
  const segments: Segment[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const startTimeSec = Math.floor((index * sourceDurationSec) / segmentCount);
    const endTimeSec =
      index === segmentCount - 1
        ? sourceDurationSec
        : Math.floor(((index + 1) * sourceDurationSec) / segmentCount);

    segments.push({
      index,
      startTimeSec,
      endTimeSec: Math.max(startTimeSec + 1, endTimeSec),
    });
  }
  return segments;
}

function buildFixedDurationSegments(
  sourceDurationSec: number,
  segmentDurationSec: number,
): Segment[] {
  const segments: Segment[] = [];
  for (
    let startTimeSec = 0, index = 0;
    startTimeSec < sourceDurationSec;
    startTimeSec += segmentDurationSec, index += 1
  ) {
    segments.push({
      index,
      startTimeSec,
      endTimeSec: Math.min(sourceDurationSec, startTimeSec + segmentDurationSec),
    });
  }
  return segments;
}

export default function UploadSegmentSelector({
  sourceDurationSec,
  selectedStartTimeSec,
  selectedEndTimeSec,
  isSelectionLocked,
  onSelectSegment,
}: Props) {
  const normalizedSourceDurationSec = Math.max(1, Math.ceil(sourceDurationSec));
  const isFixedDurationMode =
    normalizedSourceDurationSec <= MAX_UPLOAD_VIDEO_DURATION_SECONDS;
  const minimumSegmentCount = getDefaultSegmentCount(normalizedSourceDurationSec);
  const [segmentCount, setSegmentCount] = useState(minimumSegmentCount);

  useEffect(() => {
    setSegmentCount(minimumSegmentCount);
  }, [minimumSegmentCount, normalizedSourceDurationSec]);

  const clampedSegmentCount = clampSegmentCount(
    segmentCount,
    normalizedSourceDurationSec,
    minimumSegmentCount,
  );
  const segments = useMemo(
    () =>
      isFixedDurationMode
        ? buildFixedDurationSegments(
            normalizedSourceDurationSec,
            SHORT_VIDEO_SEGMENT_SECONDS,
          )
        : buildEqualSegments(normalizedSourceDurationSec, clampedSegmentCount),
    [clampedSegmentCount, isFixedDurationMode, normalizedSourceDurationSec],
  );
  const selectedSegmentIndex = segments.findIndex(
    segment =>
      segment.startTimeSec === selectedStartTimeSec &&
      segment.endTimeSec === selectedEndTimeSec,
  );
  const selectedSegment =
    selectedSegmentIndex >= 0 ? segments[selectedSegmentIndex] : null;

  useEffect(() => {
    if (isSelectionLocked || segments.length === 0 || selectedSegment != null) {
      return;
    }

    const containingSegment = segments.find(
      segment =>
        selectedStartTimeSec >= segment.startTimeSec &&
        selectedStartTimeSec < segment.endTimeSec,
    );
    const nextSegment = containingSegment ?? segments[0];
    onSelectSegment(nextSegment.startTimeSec, nextSegment.endTimeSec);
  }, [
    isSelectionLocked,
    onSelectSegment,
    segments,
    selectedSegment,
    selectedStartTimeSec,
  ]);

  function updateSegmentCount(nextSegmentCount: number) {
    setSegmentCount(
      clampSegmentCount(
        nextSegmentCount,
        normalizedSourceDurationSec,
        minimumSegmentCount,
      ),
    );
  }

  const displayedSegment = selectedSegment ?? segments[0];
  const selectedDurationSec =
    displayedSegment == null
      ? 0
      : displayedSegment.endTimeSec - displayedSegment.startTimeSec;

  return (
    <div>
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-gray-400">
            Equal segments
          </div>
          <div className="mt-2 text-sm leading-6 text-gray-300">
            {isFixedDurationMode
              ? `1-minute segments from ${formatDuration(normalizedSourceDurationSec)}.`
              : `${clampedSegmentCount} segments from ${formatDuration(normalizedSourceDurationSec)}.`}
          </div>
        </div>
        {!isFixedDurationMode && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Decrease segment count"
              disabled={isSelectionLocked || clampedSegmentCount <= minimumSegmentCount}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-lg font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => updateSegmentCount(clampedSegmentCount - 1)}>
              -
            </button>
            <input
              type="number"
              min={minimumSegmentCount}
              max={normalizedSourceDurationSec}
              step={1}
              value={clampedSegmentCount}
              disabled={isSelectionLocked}
              className="h-9 w-20 rounded-lg border border-white/10 bg-black/20 px-2 text-center text-sm font-medium text-white outline-none disabled:cursor-not-allowed disabled:opacity-60"
              onChange={event => updateSegmentCount(Number(event.currentTarget.value))}
            />
            <button
              type="button"
              aria-label="Increase segment count"
              disabled={isSelectionLocked || clampedSegmentCount >= normalizedSourceDurationSec}
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-lg font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => updateSegmentCount(clampedSegmentCount + 1)}>
              +
            </button>
          </div>
        )}
      </div>

      {displayedSegment != null && (
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">
              Start
            </div>
            <div className="mt-1 text-sm font-medium text-white">
              {formatDuration(displayedSegment.startTimeSec)}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">
              End
            </div>
            <div className="mt-1 text-sm font-medium text-white">
              {formatDuration(displayedSegment.endTimeSec)}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">
              Length
            </div>
            <div className="mt-1 text-sm font-medium text-white">
              {formatDuration(selectedDurationSec)}
            </div>
          </div>
        </div>
      )}

      <div className="mt-4 max-h-[320px] overflow-y-auto pr-1">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {segments.map(segment => {
            const isSelected = segment.index === selectedSegmentIndex;
            const durationSec = segment.endTimeSec - segment.startTimeSec;
            return (
              <button
                key={segment.index}
                type="button"
                disabled={isSelectionLocked}
                className={`rounded-lg border px-3 py-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                  isSelected
                    ? 'border-[#FB73A5] bg-[#FB73A5]/15 text-white'
                    : 'border-white/10 bg-black/10 text-gray-300 hover:border-white/30 hover:bg-white/5'
                }`}
                onClick={() =>
                  onSelectSegment(segment.startTimeSec, segment.endTimeSec)
                }>
                <div className="text-xs font-semibold uppercase tracking-[0.16em]">
                  Segment {segment.index + 1}
                </div>
                <div className="mt-2 text-sm font-medium text-white">
                  {formatDuration(segment.startTimeSec)} - {formatDuration(segment.endTimeSec)}
                </div>
                <div className="mt-1 text-xs text-gray-400">
                  {formatDuration(durationSec)}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-black/10 px-4 py-3 text-sm leading-6 text-gray-300">
        Only the selected segment will be prepared for SAM 2.
      </div>
    </div>
  );
}
