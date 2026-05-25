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
import {
  defaultMessageMap,
  MessagesEventMap,
} from '@/common/components/snackbar/DemoMessagesSnackbarUtils';
import {Effects} from '@/common/components/video/effects/Effects';
import {
  DemoEffect,
  highlightEffects,
} from '@/common/components/effects/EffectsUtils';
import {
  AnnotationExportPayload,
  BaseTracklet,
  SegmentationPoint,
  StreamingState,
} from '@/common/tracker/Tracker';
import type {DataArray} from '@/jscocotools/mask';
import {atom} from 'jotai';

export type VideoMode = 'preview' | 'ready';

export type VideoData = {
  mode: VideoMode;
  path: string | null;
  posterPath: string | null | undefined;
  url: string;
  posterUrl: string;
  width: number;
  height: number;
};

type ReadyVideoSource = {
  path: string;
  posterPath: string | null | undefined;
  url: string;
  posterUrl: string | null | undefined;
  width: number;
  height: number;
};

type PreviewVideoSource = {
  url: string;
  width: number;
  height: number;
  posterUrl?: string | null;
  posterPath?: string | null;
};

export function createReadyVideoData(video: ReadyVideoSource): VideoData {
  return {
    mode: 'ready',
    path: video.path,
    posterPath: video.posterPath ?? null,
    url: video.url,
    posterUrl: video.posterUrl ?? '',
    width: video.width,
    height: video.height,
  };
}

export function createPreviewVideoData(video: PreviewVideoSource): VideoData {
  return {
    mode: 'preview',
    path: null,
    posterPath: video.posterPath ?? null,
    url: video.url,
    posterUrl: video.posterUrl ?? '',
    width: video.width,
    height: video.height,
  };
}

export function isPreviewVideo(video: VideoData | null | undefined): boolean {
  return video?.mode === 'preview' || video?.path == null;
}

export const frameIndexAtom = atom<number>(0);

export const inputVideoAtom = atom<VideoData | null>(null);

export type TrimRange = {
  startFrame: number;
  endFrameExclusive: number;
};

export const DEFAULT_TRIM_RANGE: TrimRange = {
  startFrame: 0,
  endFrameExclusive: 1,
};

export function clampTrimRange(
  range: TrimRange,
  totalFrames: number,
): TrimRange {
  const frameCount = Math.max(1, Math.floor(totalFrames));
  const startFrame = 0;
  const endFrameExclusive = Math.max(
    1,
    Math.min(frameCount, Math.floor(range.endFrameExclusive)),
  );

  return {startFrame, endFrameExclusive};
}

export const trimRangeAtom = atom<TrimRange>(DEFAULT_TRIM_RANGE);

// #####################
// SESSION
// #####################

export type Session = {
  id: string;
  ranPropagation: boolean;
};

export const sessionAtom = atom<Session | null>(null);

export const annotationExportSnapshotAtom =
  atom<AnnotationExportPayload | null>(null);

// #####################
// STREAMING/PLAYBACK
// #####################

export const isVideoLoadingAtom = atom<boolean>(false);

export const streamingStateAtom = atom<StreamingState>('none');

export const isPlayingAtom = atom<boolean>(false);

export const isStreamingAtom = atom<boolean>(false);

// #####################
// OBJECTS
// #####################

export type TrackletMask = {
  mask: DataArray;
  isEmpty: boolean;
};

export type TrackletObject = {
  id: number;
  color: string;
  thumbnail: string | null;
  points: SegmentationPoint[][];
  masks: TrackletMask[];
  isInitialized: boolean;
};

export const MAX_NUMBER_TRACKLET_OBJECTS = 20;

export const activeTrackletObjectIdAtom = atom<number | null>(0);

export const activeTrackletObjectAtom = atom<BaseTracklet | null>(get => {
  const objectId = get(activeTrackletObjectIdAtom);
  const tracklets = get(trackletObjectsAtom);
  return tracklets.find(obj => obj.id === objectId) ?? null;
});

export const trackletObjectsAtom = atom<BaseTracklet[]>([]);

export type TrackletObjectNames = Record<number, string>;

export const trackletObjectNamesAtom = atom<TrackletObjectNames>({});

export const maxTrackletObjectIdAtom = atom<number>(get => {
  const tracklets = get(trackletObjectsAtom);
  return tracklets.reduce((prev, curr) => Math.max(prev, curr.id), 0);
});

export const isTrackletObjectLimitReachedAtom = atom<boolean>(
  get => get(trackletObjectsAtom).length >= MAX_NUMBER_TRACKLET_OBJECTS,
);

export const areTrackletObjectsInitializedAtom = atom<boolean>(get =>
  get(trackletObjectsAtom).every(obj => obj.isInitialized),
);

export const isFirstClickMadeAtom = atom(get => {
  const tracklets = get(trackletObjectsAtom);
  return tracklets.some(tracklet => tracklet.points.length > 0);
});

export const pointsAtom = atom<SegmentationPoint[]>(get => {
  const frameIndex = get(frameIndexAtom);
  const activeTracklet = get(activeTrackletObjectAtom);
  return activeTracklet?.points[frameIndex] ?? [];
});

export const labelTypeAtom = atom<'positive' | 'negative'>('positive');

export const isAddObjectEnabledAtom = atom<boolean>(get => {
  const session = get(sessionAtom);
  const trackletsInitialized = get(areTrackletObjectsInitializedAtom);
  const isObjectLimitReached = get(isTrackletObjectLimitReachedAtom);
  return session != null && trackletsInitialized && !isObjectLimitReached;
});

export const codeEditorOpenedAtom = atom<boolean>(false);

export const tutorialVideoEnabledAtom = atom<boolean>(true);

// #####################
// Effects
// #####################

type EffectConfig = {
  name: keyof Effects;
  variant: number;
  numVariants: number;
};

export const activeBackgroundEffectAtom = atom<EffectConfig>({
  name: 'Original',
  variant: 0,
  numVariants: 0,
});

export const activeHighlightEffectAtom = atom<EffectConfig>({
  name: 'Overlay',
  variant: 0,
  numVariants: 0,
});

export const activeHighlightEffectGroupAtom =
  atom<DemoEffect[]>(highlightEffects);

// #####################
// Toolbar
// #####################

export const toolbarTabIndex = atom<number>(0);

// #####################
// Messages snackbar
// #####################

export const messageMapAtom = atom<MessagesEventMap>(defaultMessageMap);

// #####################
// Upload state
// #####################

export type UploadingState =
  | 'default'
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'error';

export type UploadSessionStatus =
  | 'uploading'
  | 'uploaded'
  | 'processing'
  | 'ready'
  | 'error';

export type UploadSession = {
  uploadId: string | null;
  status: UploadSessionStatus;
  uploadedBytes: number;
  totalBytes: number;
  chunkSizeBytes: number | null;
  objectUrl: string;
  shouldRevokeObjectUrl: boolean;
  controller: AbortController;
  previewVideo: VideoData;
  readyVideo: VideoData | null;
  error: string | null;
  sourceDurationSec: number;
  selectedStartTimeSec: number;
  selectedEndTimeSec: number;
};

export const uploadingStateAtom = atom<UploadingState>('default');

export const uploadErrorAtom = atom<string | null>(null);

export const uploadSessionAtom = atom<UploadSession | null>(null);
