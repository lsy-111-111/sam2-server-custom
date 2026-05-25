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
import VideoWorkerContext from '@/common/components/video/VideoWorkerContext';

import {TrackerOptions} from '@/common/tracker/Trackers';
import {TrackerResponse} from '@/common/tracker/TrackerTypes';
import {RLEObject} from '@/jscocotools/mask';

export type Point = [x: number, y: number];

export type FrameRange = {
  startFrame: number;
  endFrameExclusive: number;
};

export type SegmentationPoint = [...point: Point, label: 0 | 1];

export type FramePoints = Array<SegmentationPoint> | undefined;

export type Mask = DatalessMask & {
  data: Blob | RLEObject;
};

export type DatalessMask = {
  shape: number[];
  bounds: [[number, number], [number, number]];
  isEmpty: boolean;
};

export type Tracklet = {
  id: number;
  color: string;
  thumbnail: string | null;
  points: FramePoints[];
  masks: Mask[];
  isInitialized: boolean;
};

export type BaseTracklet = Omit<Tracklet, 'masks'> & {
  masks: DatalessMask[];
};

export type AnnotationExportAnnotation = {
  object_id: number;
  object_name: string;
  rle: RLEObject;
  points: SegmentationPoint[];
};

export type AnnotationExportFrame = {
  frame_index: number;
  annotations: AnnotationExportAnnotation[];
};

export type AnnotationExportPayload = {
  session_id: string | null;
  export_every_n_frames: number;
  export_sampling_mode?: 'frames' | 'seconds' | 'frame_list';
  export_every_n_seconds?: number;
  export_source_fps?: number;
  export_frame_list_file_name?: string;
  export_frame_indices?: number[];
  frames: AnnotationExportFrame[];
};

export type StreamingState =
  | 'none'
  | 'required'
  | 'requesting'
  | 'aborting'
  | 'aborted'
  | 'partial'
  | 'full';

export interface ITracker {
  startSession(videoUrl: string): Promise<void>;
  closeSession(): Promise<void>;
  createTracklet(): void;
  deleteTracklet(trackletId: number): Promise<void>;
  updatePoints(
    frameIndex: number,
    objectId: number,
    points: SegmentationPoint[],
  ): Promise<void>;
  clearPointsInFrame(frameIndex: number, objectId: number): Promise<void>;
  clearPointsInVideo(): Promise<void>;
  streamMasks(frameIndex: number, frameRange?: FrameRange): Promise<void>;
  exportAnnotations(
    everyNFrames: number,
    onlyAnnotatedFrames: boolean,
    frameRange?: FrameRange,
  ): Promise<void>;
  trimTrackletsToRange(frameRange: FrameRange): Promise<void>;
  abortStreamMasks(): void;
  enableStats(): void;
}

export abstract class Tracker implements ITracker {
  protected _context: VideoWorkerContext;
  constructor(context: VideoWorkerContext, _options?: TrackerOptions) {
    this._context = context;
  }
  abstract startSession(videoUrl: string): Promise<void>;
  abstract closeSession(): Promise<void>;
  abstract createTracklet(): void;
  abstract deleteTracklet(trackletId: number): Promise<void>;
  abstract updatePoints(
    frameIndex: number,
    objectId: number,
    points: SegmentationPoint[],
  ): Promise<void>;
  abstract clearPointsInFrame(
    frameIndex: number,
    objectId: number,
  ): Promise<void>;
  abstract clearPointsInVideo(): Promise<void>;
  abstract streamMasks(
    frameIndex: number,
    frameRange?: FrameRange,
  ): Promise<void>;
  abstract exportAnnotations(
    everyNFrames: number,
    onlyAnnotatedFrames: boolean,
    frameRange?: FrameRange,
  ): Promise<void>;
  abstract trimTrackletsToRange(frameRange: FrameRange): Promise<void>;
  abstract abortStreamMasks(): void;
  abstract enableStats(): void;

  // PRIVATE FUNCTIONS

  protected _sendResponse<T extends TrackerResponse>(
    action: T['action'],
    message?: Omit<T, 'action'>,
    transfer?: Transferable[],
  ): void {
    self.postMessage(
      {
        action,
        ...message,
      },
      {
        transfer,
      },
    );
  }
}
