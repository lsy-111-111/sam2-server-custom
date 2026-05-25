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
import {getFileName} from '@/common/components/options/ShareUtils';
import useReportError from '@/common/error/useReportError';
import {
  EncodingCompletedEvent,
  EncodingStateUpdateEvent,
} from '@/common/components/video/VideoWorkerBridge';
import useVideo from '@/common/components/video/editor/useVideo';
import {trimRangeAtom} from '@/demo/atoms';
import {useAtomValue} from 'jotai';
import {MP4ArrayBuffer} from 'mp4box';
import {useState} from 'react';

type DownloadingState = 'default' | 'started' | 'encoding' | 'completed';

type State = {
  state: DownloadingState;
  progress: number;
  canDownload: boolean;
  download: (shouldSave?: boolean) => Promise<MP4ArrayBuffer | null>;
};

export default function useDownloadVideo(): State {
  const [downloadingState, setDownloadingState] =
    useState<DownloadingState>('default');
  const [progress, setProgress] = useState<number>(0);

  const video = useVideo();
  const trimRange = useAtomValue(trimRangeAtom);
  const reportError = useReportError();

  const canDownload =
    video != null &&
    video.isDecodeComplete &&
    video.decodedFrameCount === video.numberOfFrames &&
    (downloadingState === 'default' || downloadingState === 'completed');

  async function download(shouldSave = true): Promise<MP4ArrayBuffer | null> {
    if (video == null) {
      return null;
    }

    if (downloadingState !== 'default' && downloadingState !== 'completed') {
      return null;
    }

    if (
      !video.isDecodeComplete ||
      video.decodedFrameCount !== video.numberOfFrames
    ) {
      reportError(
        new Error(
          'Video is still decoding. Please wait until loading finishes before downloading.',
        ),
      );
      return null;
    }

    const activeVideo = video;

    return new Promise(resolve => {
      function cleanup() {
        activeVideo.removeEventListener('encodingCompleted', onEncodingComplete);
        activeVideo.removeEventListener('encodingStateUpdate', onEncodingStateUpdate);
        activeVideo.removeEventListener('error', onError);
      }

      function onEncodingStateUpdate(event: EncodingStateUpdateEvent) {
        setDownloadingState('encoding');
        setProgress(event.progress);
      }

      function onEncodingComplete(event: EncodingCompletedEvent) {
        const file = event.file;

        if (shouldSave) {
          saveVideo(file, getFileName());
        }

        cleanup();
        setDownloadingState('completed');
        resolve(file);
      }

      function onError() {
        cleanup();
        setDownloadingState('default');
        setProgress(0);
        resolve(null);
      }

      activeVideo.addEventListener('encodingStateUpdate', onEncodingStateUpdate);
      activeVideo.addEventListener('encodingCompleted', onEncodingComplete);
      activeVideo.addEventListener('error', onError);

      setDownloadingState('started');
      activeVideo.pause();
      activeVideo.encode(trimRange);
    });
  }

  function saveVideo(file: MP4ArrayBuffer, fileName: string) {
    const blob = new Blob([file]);
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    document.body.appendChild(a);
    a.setAttribute('href', url);
    a.setAttribute('download', fileName);
    a.setAttribute('target', '_self');
    a.click();
    window.URL.revokeObjectURL(url);
  }

  return {download, progress, state: downloadingState, canDownload};
}
