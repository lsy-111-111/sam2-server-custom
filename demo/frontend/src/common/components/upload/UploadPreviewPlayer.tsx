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
import type {UploadPreviewMode} from '@/common/components/upload/UploadPreviewMode';
import UploadSegmentSelector from '@/common/components/upload/UploadSegmentSelector';
import useUploadSession from '@/common/components/upload/useUploadSession';
import {VideoData} from '@/demo/atoms';
import {MAX_UPLOAD_VIDEO_DURATION_SECONDS} from '@/demo/DemoConfig';
import {useCallback, useRef, useState} from 'react';

type Props = {
  video: VideoData;
  previewMode: UploadPreviewMode;
  showSegmentMode: boolean;
};

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

export default function UploadPreviewPlayer({
  video,
  previewMode,
  showSegmentMode,
}: Props) {
  const {uploadSession, setSelectedClip} = useUploadSession();
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const aspectRatio =
    video.width > 0 && video.height > 0
      ? `${video.width} / ${video.height}`
      : '16 / 9';
  const sourceDurationSec = Math.max(
    1,
    Math.ceil(
      uploadSession?.sourceDurationSec ?? MAX_UPLOAD_VIDEO_DURATION_SECONDS,
    ),
  );
  const selectedStartTimeSec = uploadSession?.selectedStartTimeSec ?? 0;
  const selectedEndTimeSec =
    uploadSession?.selectedEndTimeSec ??
    Math.min(sourceDurationSec, MAX_UPLOAD_VIDEO_DURATION_SECONDS);
  const selectedDurationSec = Math.max(
    0,
    selectedEndTimeSec - selectedStartTimeSec,
  );
  const selectedRangeWidth = Math.max(
    0,
    (selectedEndTimeSec / sourceDurationSec) * 100 -
      (selectedStartTimeSec / sourceDurationSec) * 100,
  );
  const isSelectionLocked =
    uploadSession?.status === 'processing' || uploadSession?.status === 'ready';
  const isSegmentMode = previewMode === 'segments' && showSegmentMode;

  const handleSegmentSelect = useCallback(
    (startTimeSec: number, endTimeSec: number) => {
      setSelectedClip(startTimeSec, endTimeSec);
      if (videoElementRef.current != null) {
        videoElementRef.current.currentTime = startTimeSec;
      }
    },
    [setSelectedClip],
  );

  function handleStartTimeChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const requestedStartTimeSec = Number(event.currentTarget.value);
    let nextStartTimeSec = Math.min(
      Math.max(0, requestedStartTimeSec),
      selectedEndTimeSec - 1,
    );

    if (
      selectedEndTimeSec - nextStartTimeSec >
      MAX_UPLOAD_VIDEO_DURATION_SECONDS
    ) {
      nextStartTimeSec =
        selectedEndTimeSec - MAX_UPLOAD_VIDEO_DURATION_SECONDS;
    }

    setSelectedClip(nextStartTimeSec, selectedEndTimeSec);
  }

  function handleEndTimeChange(event: React.ChangeEvent<HTMLInputElement>) {
    const requestedEndTimeSec = Number(event.currentTarget.value);
    let nextEndTimeSec = Math.max(
      selectedStartTimeSec + 1,
      Math.min(sourceDurationSec, requestedEndTimeSec),
    );

    if (
      nextEndTimeSec - selectedStartTimeSec >
      MAX_UPLOAD_VIDEO_DURATION_SECONDS
    ) {
      nextEndTimeSec =
        selectedStartTimeSec + MAX_UPLOAD_VIDEO_DURATION_SECONDS;
    }

    setSelectedClip(selectedStartTimeSec, nextEndTimeSec);
  }

  return (
    <div className="flex w-full flex-1 flex-col overflow-hidden rounded-xl border-8 border-graydark-800 bg-graydark-800 md:min-h-0">
      <div
        className="relative w-full flex-1 overflow-hidden bg-black"
        style={{aspectRatio}}>
        <video
          ref={videoElementRef}
          className="h-full w-full"
          src={video.url}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={() => setVideoLoadError(null)}
          onError={() => {
            setVideoLoadError(
              `Could not open the preview stream ${video.url}. The backend already accepted the import, so this usually means the frontend is not proxying /api/uploads/... correctly, or the selected server file is no longer readable.`,
            );
          }}
        />
        {videoLoadError != null && (
          <div className="absolute inset-x-4 bottom-4 rounded-xl border border-red-400/30 bg-red-500/15 px-4 py-3 text-sm leading-6 text-red-100">
            {videoLoadError}
          </div>
        )}
      </div>
      <div className="border-t border-white/10 bg-black/20 px-4 py-4 md:px-5">
        <div className="flex items-center justify-between gap-4 text-xs uppercase tracking-[0.2em] text-gray-400">
          <span>Selected {isSegmentMode ? 'segment' : 'clip'}</span>
          <span>Source {formatDuration(sourceDurationSec)}</span>
        </div>
        {isSegmentMode ? (
          <UploadSegmentSelector
            sourceDurationSec={sourceDurationSec}
            selectedStartTimeSec={selectedStartTimeSec}
            selectedEndTimeSec={selectedEndTimeSec}
            isSelectionLocked={isSelectionLocked}
            onSelectSegment={handleSegmentSelect}
          />
        ) : (
          <>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">
                  Start
                </div>
                <div className="mt-1 text-sm font-medium text-white">
                  {formatDuration(selectedStartTimeSec)}
                </div>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/10 px-3 py-3">
                <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">
                  End
                </div>
                <div className="mt-1 text-sm font-medium text-white">
                  {formatDuration(selectedEndTimeSec)}
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
            <div className="mt-4">
              <div className="relative h-8">
                <div className="absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-white/10" />
                <div
                  className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-gradient-to-r from-[#595FEF] to-[#FB73A5]"
                  style={{
                        left: `${(selectedStartTimeSec / sourceDurationSec) * 100}%`,
                        width: `${selectedRangeWidth}%`,
                  }}
                />
                <input
                  type="range"
                  min={0}
                  max={sourceDurationSec}
                  step={1}
                  value={selectedStartTimeSec}
                  disabled={isSelectionLocked}
                  onChange={handleStartTimeChange}
                  className="clip-range-slider absolute inset-0 h-8 w-full bg-transparent"
                />
                <input
                  type="range"
                  min={0}
                  max={sourceDurationSec}
                  step={1}
                  value={selectedEndTimeSec}
                  disabled={isSelectionLocked}
                  onChange={handleEndTimeChange}
                  className="clip-range-slider absolute inset-0 h-8 w-full bg-transparent"
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                <span>0:00</span>
                <span>{formatDuration(sourceDurationSec)}</span>
              </div>
            </div>
            <div className="mt-4 rounded-xl border border-white/10 bg-black/10 px-4 py-3 text-sm leading-6 text-gray-300">
              Only the selected clip will be sent to SAM 2. Each selected clip can
              be up to {formatDuration(MAX_UPLOAD_VIDEO_DURATION_SECONDS)}.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
