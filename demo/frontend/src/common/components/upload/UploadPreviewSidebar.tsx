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
import ChangeVideoModal from '@/common/components/gallery/ChangeVideoModal';
import type {UploadPreviewMode} from '@/common/components/upload/UploadPreviewMode';
import type {VideoGalleryTriggerProps} from '@/common/components/gallery/DemoVideoGalleryModal';
import OptionButton from '@/common/components/options/OptionButton';
import useUploadSession from '@/common/components/upload/useUploadSession';
import {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_VIDEO_DURATION_SECONDS,
} from '@/demo/DemoConfig';
import {ImageCopy, PlayFilledAlt} from '@carbon/icons-react';

function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

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

type Props = {
  previewMode: UploadPreviewMode;
  showSegmentMode: boolean;
  onPreviewModeChange: (mode: UploadPreviewMode) => void;
  onStartInteraction: () => void;
};

export default function UploadPreviewSidebar({
  previewMode,
  showSegmentMode,
  onPreviewModeChange,
  onStartInteraction,
}: Props) {
  const {uploadSession} = useUploadSession();

  const status = uploadSession?.status ?? 'uploading';
  const uploadedBytes = uploadSession?.uploadedBytes ?? 0;
  const totalBytes = uploadSession?.totalBytes ?? 0;
  const progress =
    totalBytes > 0
      ? Math.min(100, Math.round((uploadedBytes / totalBytes) * 100))
      : 0;
  const isUploadTransferred =
    totalBytes > 0 && uploadedBytes >= totalBytes;
  const progressWidth =
    isUploadTransferred || status === 'processing' || status === 'ready'
      ? 100
      : progress;
  const errorMessage = uploadSession?.error;
  const selectedStartTimeSec = uploadSession?.selectedStartTimeSec ?? 0;
  const selectedEndTimeSec = uploadSession?.selectedEndTimeSec ?? 0;
  const selectedDurationSec = Math.max(
    0,
    selectedEndTimeSec - selectedStartTimeSec,
  );
  const isStartEnabled = status === 'uploaded' && selectedDurationSec >= 1;
  const isStartLoading = status === 'processing' || status === 'ready';
  const isSegmentMode = previewMode === 'segments' && showSegmentMode;
  const selectedRangeLabel = isSegmentMode ? 'segment' : 'clip';

  const title =
    status === 'processing'
      ? `Preparing selected ${selectedRangeLabel}`
      : status === 'ready'
        ? 'Opening editor'
        : status === 'uploaded'
          ? isSegmentMode
            ? 'Select a segment'
            : 'Select a clip'
          : status === 'error'
            ? 'Could not prepare the clip'
            : 'Uploading video';

  const description =
    status === 'processing'
      ? `The full file is on the server. We are transcoding only the selected ${selectedRangeLabel} into an interaction-optimized MP4 for SAM 2.`
      : status === 'ready'
        ? `The selected ${selectedRangeLabel} is ready. Switching to the editor now.`
        : status === 'uploaded'
          ? isSegmentMode
            ? 'Choose one equal time segment, then start interaction to prepare only that segment for annotation and tracking.'
            : 'The full file is on the server. Start interaction to prepare only the selected clip for annotation and tracking.'
          : status === 'error'
            ? `Please try another video. Max file size is ${MAX_UPLOAD_FILE_SIZE}, and the selected clip limit is ${MAX_UPLOAD_VIDEO_DURATION_SECONDS}s.`
            : `You can preview immediately while the original file uploads. Pick the ${selectedRangeLabel} now, and we will process only that range once the upload finishes.`;

  return (
    <div className="w-full max-w-[360px] shrink-0 rounded-xl border border-white/10 bg-graydark-700 p-5 md:p-6">
      <div className="mb-5">
        <div className="text-sm uppercase tracking-[0.2em] text-gray-400">
          Preview mode
        </div>
        <h2 className="mt-2 text-2xl font-semibold text-white">{title}</h2>
        <p className="mt-3 text-sm leading-6 text-gray-300">{description}</p>
      </div>

      {showSegmentMode && (
        <div className="mb-4 grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-black/20 p-1">
          <button
            type="button"
            disabled={isStartLoading}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
              !isSegmentMode
                ? 'bg-white text-graydark-800'
                : 'text-gray-300 hover:bg-white/10 hover:text-white'
            }`}
            onClick={() => onPreviewModeChange('manual')}>
            Manual clip
          </button>
          <button
            type="button"
            disabled={isStartLoading}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
              isSegmentMode
                ? 'bg-white text-graydark-800'
                : 'text-gray-300 hover:bg-white/10 hover:text-white'
            }`}
            onClick={() => onPreviewModeChange('segments')}>
            Equal segments
          </button>
        </div>
      )}

      <div className="rounded-xl border border-white/10 bg-black/20 p-4">
        <div className="flex items-center justify-between text-sm text-gray-300">
          <span>Status</span>
          <span className="font-medium capitalize text-white">{status}</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full bg-gradient-to-r from-[#595FEF] to-[#FB73A5] transition-all duration-300"
            style={{width: `${progressWidth}%`}}
          />
        </div>
        <div className="mt-3 flex items-center justify-between text-sm text-gray-300">
          <span>{formatBytes(uploadedBytes)} uploaded</span>
          <span>{totalBytes > 0 ? formatBytes(totalBytes) : '--'}</span>
        </div>
      </div>

      {uploadSession != null && (
        <div className="mt-4 grid grid-cols-3 gap-2">
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
      )}

      {errorMessage != null && (
        <div className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-100">
          {errorMessage}
        </div>
      )}

      <div className="mt-5 space-y-3">
        <OptionButton
          variant="gradient"
          title={`Use selected ${selectedRangeLabel} for annotation`}
          Icon={PlayFilledAlt}
          isDisabled={!isStartEnabled || isStartLoading}
          loadingProps={
            isStartLoading
              ? {
                  loading: true,
                  label:
                    status === 'ready'
                      ? 'Opening editor...'
                      : `Preparing selected ${selectedRangeLabel}...`,
                }
              : undefined
          }
          onClick={onStartInteraction}
        />
        <ChangeVideoModal
          videoGalleryModalTrigger={UploadPreviewSidebarChangeVideoTrigger}
        />
      </div>

      <div className="mt-5 rounded-xl border border-white/10 bg-black/10 px-4 py-3 text-sm leading-6 text-gray-300">
        Preview mode supports watching, scrubbing, and selecting a time range.
        Annotation, propagation, and restart stay disabled until the selected
        {` ${selectedRangeLabel} `} is prepared on the server.
      </div>
    </div>
  );
}

function UploadPreviewSidebarChangeVideoTrigger({
  onClick,
}: VideoGalleryTriggerProps) {
  return (
    <OptionButton
      title="Change video"
      Icon={ImageCopy}
      onClick={onClick}
    />
  );
}
