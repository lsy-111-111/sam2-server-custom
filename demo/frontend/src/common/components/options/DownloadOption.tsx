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
import useExportAnnotations, {
  normalizeExportEveryNFrames,
  normalizeExportEveryNSeconds,
  type AnnotationExportSamplingConfig,
} from '@/common/components/options/useExportAnnotations';
import {parseFrameListText} from '@/common/components/options/frameListExport';
import type {LocalFileSystemDirectoryHandle} from '@/types/file-system-access';
import {Package} from '@carbon/icons-react';
import {ChangeEvent, useRef, useState} from 'react';

type SamplingMode = AnnotationExportSamplingConfig['mode'];

function formatFramePreview(frameIndices: number[]): string {
  const previewFrameIndices = frameIndices.slice(0, 8).join(', ');
  if (frameIndices.length <= 8) {
    return previewFrameIndices;
  }
  return `${previewFrameIndices}, ...`;
}

export default function DownloadOption() {
  const [samplingMode, setSamplingMode] = useState<SamplingMode>('frames');
  const [everyNFramesInput, setEveryNFramesInput] = useState('1');
  const [everyNSecondsInput, setEveryNSecondsInput] = useState('1');
  const [frameListFileName, setFrameListFileName] = useState<string | null>(
    null,
  );
  const [frameListFrameIndices, setFrameListFrameIndices] = useState<number[]>(
    [],
  );
  const [frameListError, setFrameListError] = useState<string | null>(null);
  const [selectedDirectoryHandle, setSelectedDirectoryHandle] =
    useState<LocalFileSystemDirectoryHandle | null>(null);
  const frameListInputRef = useRef<HTMLInputElement | null>(null);
  const {
    canExport,
    chooseLocalDirectory,
    error,
    exportAnnotations,
    hasSnapshot,
    isLocalFolderPickerSupported,
    remainderMessage,
    saveMessage,
    savedPath,
    sourceFps,
    sourceFrameCount,
    state,
  } = useExportAnnotations();

  const normalizedEveryNFrames = normalizeExportEveryNFrames(
    Number(everyNFramesInput),
  );
  const normalizedEveryNSeconds = normalizeExportEveryNSeconds(
    Number(everyNSecondsInput),
  );
  const estimatedSecondModeFrameInterval =
    sourceFps > 0
      ? Math.max(1, Math.round(normalizedEveryNSeconds * sourceFps))
      : null;
  const isFrameListReady =
    samplingMode !== 'frameList' ||
    (frameListError == null && frameListFrameIndices.length > 0);
  const canRunExport = canExport && isFrameListReady;

  function getSamplingButtonClass(mode: SamplingMode): string {
    return `min-h-[52px] rounded-md px-2 py-2 text-xs font-medium leading-tight ${
      samplingMode === mode
        ? 'bg-white text-black'
        : 'text-gray-200 hover:bg-white/10'
    }`;
  }

  async function handleChooseLocalFolder() {
    const directoryHandle = await chooseLocalDirectory();
    if (directoryHandle != null) {
      setSelectedDirectoryHandle(directoryHandle);
    }
  }

  async function handleFrameListFileChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const input = event.currentTarget;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (file == null) {
      return;
    }

    setFrameListFileName(file.name);
    try {
      const frameIndices = parseFrameListText(
        await file.text(),
        sourceFrameCount,
      );
      setFrameListFrameIndices(frameIndices);
      setFrameListError(null);
    } catch (nextError) {
      setFrameListFrameIndices([]);
      setFrameListError(
        nextError instanceof Error && nextError.message.trim().length > 0
          ? nextError.message
          : 'Could not read the frame list txt file.',
      );
    }
  }

  async function handleExport() {
    const samplingConfig: AnnotationExportSamplingConfig =
      samplingMode === 'frameList'
        ? {
            mode: 'frameList',
            frameIndices: frameListFrameIndices,
            frameListFileName: frameListFileName ?? 'frame_list.txt',
            totalFrames: sourceFrameCount,
          }
        : samplingMode === 'frames'
          ? {
              mode: 'frames',
              everyNFrames: Number(everyNFramesInput),
            }
          : {
              mode: 'seconds',
              everyNSeconds: Number(everyNSecondsInput),
            };

    await exportAnnotations(selectedDirectoryHandle, samplingConfig);
  }

  return (
    <div className="rounded-lg bg-graydark-700 p-5 md:p-6 text-white">
      <div className="flex items-start gap-4">
        <div className="rounded-full border border-white/10 bg-black/20 p-3">
          <Package size={24} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-lg font-medium">Export annotations</div>
          <div className="mt-1 text-sm text-gray-300">
            Save a ZIP archive with sampled video frames and per-frame
            annotation JSON files. The export uses the cached worker snapshot
            and does not rerun propagation.
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-[minmax(0,220px)_1fr] md:items-end">
        <label className="block">
          <div className="text-sm font-medium text-gray-200">Sampling mode</div>
          <div className="mt-2 grid grid-cols-3 rounded-lg border border-white/10 bg-black/20 p-1">
            <button
              type="button"
              className={getSamplingButtonClass('frames')}
              onClick={() => setSamplingMode('frames')}>
              Every N frames
            </button>
            <button
              type="button"
              className={getSamplingButtonClass('seconds')}
              onClick={() => setSamplingMode('seconds')}>
              Every N seconds
            </button>
            <button
              type="button"
              className={getSamplingButtonClass('frameList')}
              onClick={() => setSamplingMode('frameList')}>
              Frame list .txt
            </button>
          </div>
        </label>

        {samplingMode === 'frameList' ? (
          <div className="block">
            <div className="text-sm font-medium text-gray-200">
              Frame list .txt
            </div>
            <input
              ref={frameListInputRef}
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={event => {
                void handleFrameListFileChange(event);
              }}
            />
            <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-3">
              <button
                type="button"
                className="rounded-full border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/10"
                onClick={() => frameListInputRef.current?.click()}>
                {frameListFileName == null ? 'Choose txt' : 'Change txt'}
              </button>
              <div className="mt-3 break-all font-mono text-xs text-gray-300">
                {frameListFileName ?? 'No frame list selected yet.'}
              </div>
              {frameListError == null && frameListFrameIndices.length > 0 && (
                <div className="mt-2 text-xs text-gray-200">
                  {frameListFrameIndices.length} frames:{' '}
                  {formatFramePreview(frameListFrameIndices)}
                </div>
              )}
              {frameListError != null && (
                <div className="mt-2 text-xs text-red-100">
                  {frameListError}
                </div>
              )}
            </div>
          </div>
        ) : (
          <label className="block">
            <div className="text-sm font-medium text-gray-200">
              {samplingMode === 'frames' ? 'Every N frames' : 'Every N seconds'}
            </div>
            <input
              type="number"
              min={samplingMode === 'frames' ? 1 : 0.001}
              step={samplingMode === 'frames' ? 1 : 0.1}
              value={
                samplingMode === 'frames'
                  ? everyNFramesInput
                  : everyNSecondsInput
              }
              onChange={event => {
                if (samplingMode === 'frames') {
                  setEveryNFramesInput(event.target.value);
                } else {
                  setEveryNSecondsInput(event.target.value);
                }
              }}
              className="mt-2 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-3 text-white outline-none focus:border-white/30"
            />
          </label>
        )}

        <div className="rounded-lg border border-white/10 bg-black/20 p-4 text-sm text-gray-200 md:col-span-2">
          {samplingMode === 'frameList' ? (
            frameListFrameIndices.length > 0 ? (
              <>
                Sampling rule: keep exactly{' '}
                <span className="font-mono text-white">
                  {frameListFrameIndices.length}
                </span>{' '}
                frame indices from{' '}
                <span className="font-mono text-white">
                  {frameListFileName ?? 'frame_list.txt'}
                </span>
                .
              </>
            ) : (
              <>
                Sampling rule: choose a txt file with one 0-based frame index
                per line.
              </>
            )
          ) : samplingMode === 'frames' ? (
            <>
              Sampling rule: keep frames where
              <span className="mx-1 font-mono text-white">
                frame_index % {normalizedEveryNFrames}
              </span>
              === 0.
            </>
          ) : (
            <>
              Sampling rule: keep one frame about every{' '}
              <span className="font-mono text-white">
                {normalizedEveryNSeconds}
              </span>{' '}
              seconds from the current clip timeline
              {estimatedSecondModeFrameInterval != null ? (
                <>
                  {' '}
                  (
                  <span className="font-mono text-white">
                    {estimatedSecondModeFrameInterval}
                  </span>{' '}
                  frames at {sourceFps.toFixed(2)} fps).
                </>
              ) : (
                '.'
              )}
            </>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-4 text-sm">
        <div className="font-medium text-gray-200">Local folder</div>
        <div className="mt-2 break-all font-mono text-xs text-gray-300">
          {selectedDirectoryHandle?.name ?? 'Browser downloads'}
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded-full border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!isLocalFolderPickerSupported}
            onClick={() => {
              void handleChooseLocalFolder();
            }}>
            {selectedDirectoryHandle == null
              ? 'Choose folder'
              : 'Change folder'}
          </button>
          <button
            type="button"
            className="rounded-full bg-white px-4 py-2 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canRunExport}
            onClick={() => {
              void handleExport();
            }}>
            {state === 'saving' ? 'Exporting...' : 'Export annotations'}
          </button>
        </div>
      </div>

      {!hasSnapshot && (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
          Finish propagation and click Good to go first. That step captures the
          worker-side annotation snapshot used for export.
        </div>
      )}

      {error != null && (
        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-100">
          {error}
        </div>
      )}

      {savedPath != null && (
        <div className="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-100">
          <div>
            Saved to <span className="font-mono">{savedPath}</span>
          </div>
          {saveMessage != null && (
            <div className="mt-2 text-xs text-emerald-50">{saveMessage}</div>
          )}
        </div>
      )}

      {remainderMessage != null && (
        <div className="mt-4 rounded-lg border border-cyan-400/40 bg-cyan-400/10 p-4 text-sm text-cyan-100">
          {remainderMessage}
        </div>
      )}
    </div>
  );
}
