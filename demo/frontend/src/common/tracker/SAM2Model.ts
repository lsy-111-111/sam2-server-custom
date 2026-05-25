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
import {generateThumbnail} from '@/common/components/video/editor/VideoEditorUtils';
import VideoWorkerContext from '@/common/components/video/VideoWorkerContext';
import Logger from '@/common/logger/Logger';
import {
  SAM2ModelAddNewPointsBatchMutation,
  SAM2ModelAddNewPointsBatchMutation$data,
} from '@/common/tracker/__generated__/SAM2ModelAddNewPointsBatchMutation.graphql';
import {
  SAM2ModelAddNewPointsMutation,
  SAM2ModelAddNewPointsMutation$data,
} from '@/common/tracker/__generated__/SAM2ModelAddNewPointsMutation.graphql';
import {SAM2ModelCancelPropagateInVideoMutation} from '@/common/tracker/__generated__/SAM2ModelCancelPropagateInVideoMutation.graphql';
import {SAM2ModelClearPointsInFrameMutation} from '@/common/tracker/__generated__/SAM2ModelClearPointsInFrameMutation.graphql';
import {SAM2ModelClearPointsInVideoMutation} from '@/common/tracker/__generated__/SAM2ModelClearPointsInVideoMutation.graphql';
import {SAM2ModelCloseSessionMutation} from '@/common/tracker/__generated__/SAM2ModelCloseSessionMutation.graphql';
import {SAM2ModelRemoveObjectMutation} from '@/common/tracker/__generated__/SAM2ModelRemoveObjectMutation.graphql';
import {SAM2ModelStartSessionMutation} from '@/common/tracker/__generated__/SAM2ModelStartSessionMutation.graphql';
import {
  AnnotationExportPayload,
  BaseTracklet,
  FrameRange,
  Mask,
  SegmentationPoint,
  StreamingState,
  Tracker,
  Tracklet,
} from '@/common/tracker/Tracker';
import {TrackerOptions} from '@/common/tracker/Trackers';
import {
  ClearPointsInVideoResponse,
  CloseSessionResponse,
  ExportAnnotationsResponse,
  SessionStartFailedResponse,
  SessionStartedResponse,
  StreamingCompletedResponse,
  StreamingStartedResponse,
  StreamingStateUpdateResponse,
  TrackletCreatedResponse,
  TrackletDeletedResponse,
  TrackletsUpdatedResponse,
  TrimTrackletsToRangeResponse,
} from '@/common/tracker/TrackerTypes';
import {convertMaskToRGBA} from '@/common/utils/MaskUtils';
import multipartStream from '@/common/utils/MultipartStream';
import {Stats} from '@/debug/stats/Stats';
import {INFERENCE_API_ENDPOINT} from '@/demo/DemoConfig';
import {createEnvironment} from '@/graphql/RelayEnvironment';
import {
  DataArray,
  Masks,
  RLEObject,
  decode,
  encode,
  toBbox,
} from '@/jscocotools/mask';
import {THEME_COLORS} from '@/theme/colors';
import invariant from 'invariant';
import {IEnvironment, commitMutation, graphql} from 'relay-runtime';
import {serializeError} from 'serialize-error';

type Options = Pick<TrackerOptions, 'inferenceEndpoint'>;

const POINT_UPDATE_BATCH_DELAY_MS = 16;

type PointUpdateResolver = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type PendingPointUpdate = {
  sessionId: string;
  frameIndex: number;
  objectId: number;
  points: SegmentationPoint[];
  normalizedPoints: number[][];
  labels: number[];
  updateThumbnails?: boolean;
  shouldGoToFrame?: boolean;
  resolvers: PointUpdateResolver[];
};

type AddPointsResult =
  | SAM2ModelAddNewPointsMutation$data['addPoints']
  | SAM2ModelAddNewPointsBatchMutation$data['addPointsBatch'];

type Session = {
  id: string | null;
  tracklets: {[id: number]: Tracklet};
};

type StreamMasksResult = {
  frameIndex: number;
  rleMaskList: Array<{
    objectId: number;
    rleMask: RLEObject;
  }>;
};

type StreamMasksAbortResult = {
  aborted: boolean;
};

export class SAM2Model extends Tracker {
  private _endpoint: string;
  private _environment: IEnvironment;

  private abortController: AbortController | null = null;
  private _session: Session = {
    id: null,
    tracklets: {},
  };
  private _streamingState: StreamingState = 'none';
  private _pendingPointUpdates: Map<string, PendingPointUpdate> = new Map();
  private _pointUpdateFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private _emptyMask: RLEObject | null = null;

  private _maskCanvas: OffscreenCanvas;
  private _maskCtx: OffscreenCanvasRenderingContext2D;

  private _stats?: Stats;

  constructor(
    context: VideoWorkerContext,
    options: Options = {
      inferenceEndpoint: INFERENCE_API_ENDPOINT,
    },
  ) {
    super(context);
    this._endpoint = options.inferenceEndpoint;
    this._environment = createEnvironment(options.inferenceEndpoint);

    this._maskCanvas = new OffscreenCanvas(0, 0);
    const maskCtx = this._maskCanvas.getContext('2d');
    invariant(maskCtx != null, 'context cannot be null');
    this._maskCtx = maskCtx;
  }

  public startSession(videoPath: string): Promise<void> {
    // Reset streaming state. Force update with the true flag to make sure the
    // UI updates its state.
    this._updateStreamingState('none', true);

    return new Promise(resolve => {
      const failSessionStart = (error: unknown) => {
        const sessionError =
          error instanceof Error
            ? error
            : new Error(
                typeof error === 'string'
                  ? error
                  : 'Failed to start session.',
              );
        Logger.error(sessionError);
        this._sendResponse<SessionStartFailedResponse>('sessionStartFailed', {
          error: serializeError(sessionError),
        });
        resolve();
      };

      try {
        commitMutation<SAM2ModelStartSessionMutation>(this._environment, {
          mutation: graphql`
            mutation SAM2ModelStartSessionMutation($input: StartSessionInput!) {
              startSession(input: $input) {
                sessionId
              }
            }
          `,
          variables: {
            input: {
              path: videoPath,
            },
          },
          onCompleted: (response, errors) => {
            const sessionId = response.startSession?.sessionId;
            if (errors != null && errors.length > 0) {
              failSessionStart(errors.map(({message}) => message).join('\n'));
              return;
            }
            if (sessionId == null) {
              failSessionStart('The backend did not return a session id.');
              return;
            }

            this._session.id = sessionId;

            this._sendResponse<SessionStartedResponse>('sessionStarted', {
              sessionId,
            });

            // Clear any tracklets from the previous session when
            // a new session is started
            this._clearTracklets();

            // Make an empty tracklet
            this.createTracklet();
            resolve();
          },
          onError: error => {
            failSessionStart(error);
          },
        });
      } catch (error) {
        failSessionStart(error);
      }
    });
  }

  public closeSession(): Promise<void> {
    const sessionId = this._session.id;
    if (sessionId === null) {
      this._sendResponse<CloseSessionResponse>('closeSession', {
        isSuccessful: true,
      });
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      commitMutation<SAM2ModelCloseSessionMutation>(this._environment, {
        mutation: graphql`
          mutation SAM2ModelCloseSessionMutation($input: CloseSessionInput!) {
            closeSession(input: $input) {
              success
            }
          }
        `,
        variables: {
          input: {
            sessionId,
          },
        },
        onCompleted: response => {
          const {success} = response.closeSession;
          if (success === false) {
            this._sendResponse<CloseSessionResponse>('closeSession', {
              isSuccessful: false,
            });
            reject(new Error('Failed to close session'));
            return;
          }
          this._cleanup();
          this._sendResponse<CloseSessionResponse>('closeSession', {
            isSuccessful: true,
          });
          resolve();
        },
        onError: error => {
          Logger.error(error);
          this._sendResponse<CloseSessionResponse>('closeSession', {
            isSuccessful: false,
          });
          reject(error);
        },
      });
    });
  }

  public createTracklet(): void {
    // This will return 0 for for empty tracklets and otherwise the next
    // largest number.
    const nextId =
      Object.values(this._session.tracklets).reduce(
        (prev, curr) => Math.max(prev, curr.id),
        -1,
      ) + 1;

    const usedColors = new Set(
      Object.values(this._session.tracklets).map(tracklet => tracklet.color),
    );
    const color =
      THEME_COLORS.find(themeColor => !usedColors.has(themeColor)) ??
      THEME_COLORS[nextId % THEME_COLORS.length];

    const newTracklet = {
      id: nextId,
      color,
      thumbnail: null,
      points: [],
      masks: [],
      isInitialized: false,
    };

    this._session.tracklets[nextId] = newTracklet;

    // Notify the main thread
    this._updateTracklets();

    this._sendResponse<TrackletCreatedResponse>('trackletCreated', {
      tracklet: newTracklet,
    });
  }

  public deleteTracklet(trackletId: number): Promise<void> {
    const sessionId = this._session.id;
    if (sessionId === null) {
      return Promise.reject('No active session');
    }

    const tracklet = this._session.tracklets[trackletId];
    invariant(
      tracklet != null,
      'tracklet for tracklet id %s not initialized',
      trackletId,
    );

    return new Promise((resolve, reject) => {
      commitMutation<SAM2ModelRemoveObjectMutation>(this._environment, {
        mutation: graphql`
          mutation SAM2ModelRemoveObjectMutation($input: RemoveObjectInput!) {
            removeObject(input: $input) {
              frameIndex
              rleMaskList {
                objectId
                rleMask {
                  counts
                  size
                }
              }
            }
          }
        `,
        variables: {
          input: {objectId: trackletId, sessionId},
        },
        onCompleted: response => {
          const trackletUpdates = response.removeObject;
          this._sendResponse<TrackletDeletedResponse>('trackletDeleted', {
            isSuccessful: true,
          });
          for (const trackletUpdate of trackletUpdates) {
            this._updateTrackletMasks(
              trackletUpdate,
              trackletUpdate.frameIndex === this._context.frameIndex,
              false, // shouldGoToFrame
            );
          }
          this._removeTrackletMasks(tracklet);
          resolve();
        },
        onError: error => {
          this._sendResponse<TrackletDeletedResponse>('trackletDeleted', {
            isSuccessful: false,
          });
          Logger.error(error);
          reject(error);
        },
      });
    });
  }

  public updatePoints(
    frameIndex: number,
    objectId: number,
    points: SegmentationPoint[],
  ): Promise<void> {
    const sessionId = this._session.id;
    if (sessionId === null) {
      return Promise.reject('No active session');
    }

    // TODO: This is not the right place to initialize the empty mask.
    // Move this into the constructor and listen to events on the context.
    // Note, the initial context.width and context.height is 0, so it needs
    // to happen based on an event, so when the video is initialized, it needs
    // to notify the tracker to update the empty mask.
    if (this._emptyMask === null) {
      // We need to round the height/width to the nearest integer since
      // Masks.toTensor() expects an integer value for the height/width.
      const tensor = new Masks(
        Math.trunc(this._context.height),
        Math.trunc(this._context.width),
        1,
      ).toDataArray();
      this._emptyMask = encode(tensor)[0];
    }

    const tracklet = this._session.tracklets[objectId];
    invariant(
      tracklet != null,
      'tracklet for object id %s not initialized',
      objectId,
    );

    // Mark session needing propagation when point is set
    this._updateStreamingState('required');

    // Clear all points in frame if no points are provided.
    if (points.length === 0) {
      return this.clearPointsInFrame(frameIndex, objectId);
    }

    return this._queuePointUpdate(
      this._createPointUpdate({
        sessionId,
        frameIndex,
        objectId,
        points,
      }),
    );
  }

  public clearPointsInFrame(
    frameIndex: number,
    objectId: number,
  ): Promise<void> {
    const sessionId = this._session.id;
    if (sessionId === null) {
      return Promise.reject('No active session');
    }

    const tracklet = this._session.tracklets[objectId];
    invariant(
      tracklet != null,
      'tracklet for object id %s not initialized',
      objectId,
    );

    // Mark session needing propagation when point is set
    this._updateStreamingState('required');

    return new Promise((resolve, reject) => {
      commitMutation<SAM2ModelClearPointsInFrameMutation>(this._environment, {
        mutation: graphql`
          mutation SAM2ModelClearPointsInFrameMutation(
            $input: ClearPointsInFrameInput!
          ) {
            clearPointsInFrame(input: $input) {
              frameIndex
              rleMaskList {
                objectId
                rleMask {
                  counts
                  size
                }
              }
            }
          }
        `,
        variables: {
          input: {
            sessionId,
            frameIndex,
            objectId,
          },
        },
        onCompleted: response => {
          tracklet.points[frameIndex] = [];
          tracklet.isInitialized = true;
          this._updateTrackletMasks(response.clearPointsInFrame, true);
          resolve();
        },
        onError: error => {
          Logger.error(error);
          reject(error);
        },
      });
    });
  }

  public async clearPointsInVideo(): Promise<void> {
    const sessionId = this._session.id;
    if (sessionId === null) {
      return Promise.reject('No active session');
    }

    this._updateStreamingState('none');
    const success = await this._clearBackendPointsInVideo(sessionId);
    if (!success) {
      this._sendResponse<ClearPointsInVideoResponse>('clearPointsInVideo', {
        isSuccessful: false,
      });
      return;
    }

    this._clearTracklets();
    this._context.goToFrame(this._context.frameIndex);
    this._updateTracklets();
    this._sendResponse<ClearPointsInVideoResponse>('clearPointsInVideo', {
      isSuccessful: true,
    });
  }

  public async streamMasks(
    frameIndex: number,
    frameRange?: FrameRange,
  ): Promise<void> {
    const sessionId = this._session.id;
    if (sessionId === null) {
      return Promise.reject('No active session');
    }
    try {
      this._sendResponse<StreamingStartedResponse>('streamingStarted');

      // 1. Clear previous masks
      this._context.clearMasks();
      this._clearTrackletMasks();

      // 2. Create abort controller and async generator
      const controller = new AbortController();
      this.abortController = controller;

      this._updateStreamingState('requesting');
      const normalizedFrameRange = this._normalizeFrameRange(frameRange);
      const clampedFrameIndex = Math.min(
        Math.max(frameIndex, normalizedFrameRange.startFrame),
        normalizedFrameRange.endFrameExclusive - 1,
      );
      const generator = this._streamMasksForSession(
        controller,
        sessionId,
        clampedFrameIndex,
        normalizedFrameRange,
      );

      // 3. parse stream response and update masks in session objects
      let isAborted = false;
      for await (const result of generator) {
        if ('aborted' in result) {
          this._updateStreamingState('aborting');
          await this._abortRequest();
          this._updateStreamingState('aborted');
          isAborted = true;
        } else {
          await this._updateTrackletMasks(result, false);
          this._updateStreamingState('partial');
        }
      }

      if (!isAborted) {
        // Mark session needing propagation when point is set
        this._updateStreamingState('full');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        await this._abortRequest().catch(abortError => Logger.error(abortError));
        this._updateStreamingState('aborted');
        this._sendResponse<StreamingCompletedResponse>('streamingCompleted');
        return;
      }
      Logger.error(error);
      throw error;
    }

    this._sendResponse<StreamingCompletedResponse>('streamingCompleted');
  }

  public exportAnnotations(
    everyNFrames: number = 1,
    onlyAnnotatedFrames: boolean = true,
    frameRange?: FrameRange,
  ): Promise<void> {
    const sessionId = this._session.id;
    if (sessionId === null) {
      return Promise.reject('No active session');
    }

    const normalizedEveryNFrames = Number.isFinite(everyNFrames)
      ? Math.max(1, Math.floor(everyNFrames))
      : 1;
    const normalizedFrameRange = this._normalizeFrameRange(frameRange);
    const frames: AnnotationExportPayload['frames'] = [];

    for (
      let frameIndex = normalizedFrameRange.startFrame;
      frameIndex < normalizedFrameRange.endFrameExclusive;
      frameIndex += normalizedEveryNFrames
    ) {
      const annotations: AnnotationExportPayload['frames'][number]['annotations'] = [];

      for (const tracklet of Object.values(this._session.tracklets)) {
        const mask = tracklet.masks[frameIndex];
        if (mask == null || mask.isEmpty) {
          continue;
        }

        const rle = mask.data as RLEObject;
        const points = (tracklet.points[frameIndex] ?? []).map(
          point => [point[0], point[1], point[2]] as SegmentationPoint,
        );

        annotations.push({
          object_id: tracklet.id,
          object_name: `Object ${tracklet.id + 1}`,
          rle: {
            size: [rle.size[0], rle.size[1]],
            counts: rle.counts,
          },
          points,
        });
      }

      if (!onlyAnnotatedFrames || annotations.length > 0) {
        frames.push({
          frame_index: frameIndex - normalizedFrameRange.startFrame,
          annotations,
        });
      }
    }

    this._sendResponse<ExportAnnotationsResponse>('exportAnnotations', {
      payload: {
        session_id: sessionId,
        export_every_n_frames: normalizedEveryNFrames,
        frames,
      },
    });
    return Promise.resolve();
  }

  public async trimTrackletsToRange(frameRange: FrameRange): Promise<void> {
    const sessionId = this._session.id;
    if (sessionId === null) {
      return Promise.reject('No active session');
    }

    if (this._pointUpdateFlushTimer != null) {
      clearTimeout(this._pointUpdateFlushTimer);
      this._pointUpdateFlushTimer = null;
      await this._flushPointUpdates();
    }

    const normalizedFrameRange = this._normalizeFrameRange(frameRange);
    const retainedPoints = new Map<number, Array<{frameIndex: number; points: SegmentationPoint[]}>>();

    for (const tracklet of Object.values(this._session.tracklets)) {
      const retainedForTracklet: Array<{frameIndex: number; points: SegmentationPoint[]}> = [];
      for (
        let frameIndex = normalizedFrameRange.startFrame;
        frameIndex < normalizedFrameRange.endFrameExclusive;
        frameIndex++
      ) {
        const points = tracklet.points[frameIndex];
        if (points != null && points.length > 0) {
          retainedForTracklet.push({frameIndex, points});
        }
      }
      retainedPoints.set(tracklet.id, retainedForTracklet);
    }

    const didClear = await this._clearBackendPointsInVideo(sessionId);
    if (!didClear) {
      throw new Error('Failed to clear backend tracking state for trim range');
    }

    for (const tracklet of Object.values(this._session.tracklets)) {
      const nextPoints = [] as typeof tracklet.points;
      const retainedForTracklet = retainedPoints.get(tracklet.id) ?? [];
      for (const {frameIndex, points} of retainedForTracklet) {
        nextPoints[frameIndex] = points;
      }
      tracklet.points = nextPoints;
      tracklet.masks = [];
      tracklet.isInitialized = retainedForTracklet.length > 0;
    }

    this._context.clearMasks();
    this._updateTracklets();

    const restoreUpdates: PendingPointUpdate[] = [];
    for (const [objectId, retainedForTracklet] of retainedPoints) {
      for (const {frameIndex, points} of retainedForTracklet) {
        restoreUpdates.push(
          this._createPointUpdate({
            sessionId,
            frameIndex,
            objectId,
            points,
            updateThumbnails: false,
            shouldGoToFrame: false,
          }),
        );
      }
    }

    for (const update of restoreUpdates) {
      await this._queuePointUpdate(update);
    }

    const hasInitializedTracklets = Object.values(this._session.tracklets).some(
      tracklet => tracklet.isInitialized,
    );
    this._updateStreamingState(hasInitializedTracklets ? 'required' : 'none');
    this._context.goToFrame(
      Math.min(
        Math.max(this._context.frameIndex, normalizedFrameRange.startFrame),
        normalizedFrameRange.endFrameExclusive - 1,
      ),
    );
    this._updateTracklets();
    this._sendResponse<TrimTrackletsToRangeResponse>('trimTrackletsToRange', {
      isSuccessful: true,
    });
  }

  public abortStreamMasks() {
    this.abortController?.abort();
    void this._abortRequest().catch(error => Logger.error(error));
    this._sendResponse<StreamingCompletedResponse>('streamingCompleted');
  }

  public enableStats(): void {
    this._stats = new Stats('ms', 'D', 1000 / 25);
  }

  // PRIVATE

  private _normalizeFrameRange(frameRange?: FrameRange): FrameRange {
    const totalFrames = Math.max(1, this._context.totalFrames);
    const startFrame = Math.min(
      Math.max(0, Math.floor(frameRange?.startFrame ?? 0)),
      totalFrames - 1,
    );
    const endFrameExclusive = Math.max(
      startFrame + 1,
      Math.min(
        totalFrames,
        Math.floor(frameRange?.endFrameExclusive ?? totalFrames),
      ),
    );
    return {startFrame, endFrameExclusive};
  }

  private _createPointUpdate({
    sessionId,
    frameIndex,
    objectId,
    points,
    updateThumbnails,
    shouldGoToFrame,
  }: {
    sessionId: string;
    frameIndex: number;
    objectId: number;
    points: SegmentationPoint[];
    updateThumbnails?: boolean;
    shouldGoToFrame?: boolean;
  }): PendingPointUpdate {
    const normalizedPoints = points.map(p => [
      p[0] / this._context.width,
      p[1] / this._context.height,
    ]);
    const labels = points.map(p => p[2]);
    return {
      sessionId,
      frameIndex,
      objectId,
      points,
      normalizedPoints,
      labels,
      updateThumbnails,
      shouldGoToFrame,
      resolvers: [],
    };
  }

  private _clearBackendPointsInVideo(sessionId: string): Promise<boolean> {
    return new Promise(resolve => {
      commitMutation<SAM2ModelClearPointsInVideoMutation>(this._environment, {
        mutation: graphql`
          mutation SAM2ModelClearPointsInVideoMutation(
            $input: ClearPointsInVideoInput!
          ) {
            clearPointsInVideo(input: $input) {
              success
            }
          }
        `,
        variables: {
          input: {
            sessionId,
          },
        },
        onCompleted: response => {
          resolve(response.clearPointsInVideo.success);
        },
        onError: error => {
          Logger.error(error);
          resolve(false);
        },
      });
    });
  }

  private _queuePointUpdate(
    update: PendingPointUpdate,
  ): Promise<void> {
    const key = `${update.sessionId}:${update.frameIndex}:${update.objectId}`;

    return new Promise((resolve, reject) => {
      const existingUpdate = this._pendingPointUpdates.get(key);
      const resolver = {resolve, reject};
      if (existingUpdate != null) {
        existingUpdate.points = update.points;
        existingUpdate.normalizedPoints = update.normalizedPoints;
        existingUpdate.labels = update.labels;
        existingUpdate.updateThumbnails = update.updateThumbnails;
        existingUpdate.shouldGoToFrame = update.shouldGoToFrame;
        existingUpdate.resolvers.push(resolver);
      } else {
        this._pendingPointUpdates.set(key, {
          ...update,
          resolvers: [resolver],
        });
      }

      if (this._pointUpdateFlushTimer == null) {
        this._pointUpdateFlushTimer = globalThis.setTimeout(() => {
          this._pointUpdateFlushTimer = null;
          void this._flushPointUpdates();
        }, POINT_UPDATE_BATCH_DELAY_MS);
      }
    });
  }

  private async _flushPointUpdates(): Promise<void> {
    const updates = Array.from(this._pendingPointUpdates.values());
    this._pendingPointUpdates.clear();

    const updatesByFrame = new Map<string, PendingPointUpdate[]>();
    for (const update of updates) {
      const key = `${update.sessionId}:${update.frameIndex}`;
      const frameUpdates = updatesByFrame.get(key);
      if (frameUpdates == null) {
        updatesByFrame.set(key, [update]);
      } else {
        frameUpdates.push(update);
      }
    }

    for (const frameUpdates of updatesByFrame.values()) {
      try {
        if (frameUpdates.length === 1) {
          await this._commitAddPoints(frameUpdates[0]);
        } else {
          await this._commitAddPointsBatch(frameUpdates);
        }
      } catch (error) {
        Logger.error(error);
      }
    }
  }

  private _resolvePointUpdate(update: PendingPointUpdate): void {
    for (const resolver of update.resolvers) {
      resolver.resolve();
    }
  }

  private _rejectPointUpdate(update: PendingPointUpdate, error: unknown): void {
    for (const resolver of update.resolvers) {
      resolver.reject(error);
    }
  }

  private _commitAddPoints(update: PendingPointUpdate): Promise<void> {
    return new Promise((resolve, reject) => {
      commitMutation<SAM2ModelAddNewPointsMutation>(this._environment, {
        mutation: graphql`
          mutation SAM2ModelAddNewPointsMutation($input: AddPointsInput!) {
            addPoints(input: $input) {
              frameIndex
              rleMaskList {
                objectId
                rleMask {
                  counts
                  size
                }
              }
            }
          }
        `,
        variables: {
          input: {
            sessionId: update.sessionId,
            frameIndex: update.frameIndex,
            objectId: update.objectId,
            labels: update.labels,
            points: update.normalizedPoints,
            clearOldPoints: true,
          },
        },
        onCompleted: response => {
          void (async () => {
            try {
              const tracklet = this._session.tracklets[update.objectId];
              if (tracklet != null) {
                tracklet.points[update.frameIndex] = update.points;
                tracklet.isInitialized = true;
              }
              await this._updateTrackletMasks(
                response.addPoints,
                update.updateThumbnails ?? true,
                update.shouldGoToFrame ?? true,
              );
              this._resolvePointUpdate(update);
              resolve();
            } catch (error) {
              this._rejectPointUpdate(update, error);
              reject(error);
            }
          })();
        },
        onError: error => {
          Logger.error(error);
          this._rejectPointUpdate(update, error);
          reject(error);
        },
      });
    });
  }

  private _commitAddPointsBatch(
    updates: PendingPointUpdate[],
  ): Promise<void> {
    const firstUpdate = updates[0];

    return new Promise((resolve, reject) => {
      commitMutation<SAM2ModelAddNewPointsBatchMutation>(this._environment, {
        mutation: graphql`
          mutation SAM2ModelAddNewPointsBatchMutation(
            $input: AddPointsBatchInput!
          ) {
            addPointsBatch(input: $input) {
              frameIndex
              rleMaskList {
                objectId
                rleMask {
                  counts
                  size
                }
              }
            }
          }
        `,
        variables: {
          input: {
            sessionId: firstUpdate.sessionId,
            frameIndex: firstUpdate.frameIndex,
            clearOldPoints: true,
            objects: updates.map(update => ({
              objectId: update.objectId,
              labels: update.labels,
              points: update.normalizedPoints,
            })),
          },
        },
        onCompleted: response => {
          void (async () => {
            try {
              for (const update of updates) {
                const tracklet = this._session.tracklets[update.objectId];
                if (tracklet != null) {
                  tracklet.points[update.frameIndex] = update.points;
                  tracklet.isInitialized = true;
                }
              }
              await this._updateTrackletMasks(
                response.addPointsBatch,
                updates.some(update => update.updateThumbnails ?? true),
                updates.some(update => update.shouldGoToFrame ?? true),
              );
              for (const update of updates) {
                this._resolvePointUpdate(update);
              }
              resolve();
            } catch (error) {
              for (const update of updates) {
                this._rejectPointUpdate(update, error);
              }
              reject(error);
            }
          })();
        },
        onError: error => {
          Logger.error(error);
          void (async () => {
            try {
              await Promise.all(
                updates.map(update => this._commitAddPoints(update)),
              );
              resolve();
            } catch (fallbackError) {
              reject(fallbackError);
            }
          })();
        },
      });
    });
  }

  private _cleanup() {
    this._session.id = null;
    // Clear existing tracklets
    this._session.tracklets = [];
  }

  private _clearTracklets() {
    this._session.tracklets = [];
    this._context.clearMasks();
  }

  private _updateStreamingState(
    state: StreamingState,
    forceUpdate: boolean = false,
  ) {
    if (!forceUpdate && this._streamingState === state) {
      return;
    }
    this._streamingState = state;
    this._sendResponse<StreamingStateUpdateResponse>('streamingStateUpdate', {
      state,
    });
  }

  private async _removeTrackletMasks(tracklet: Tracklet) {
    this._context.clearTrackletMasks(tracklet);
    delete this._session.tracklets[tracklet.id];

    // Notify the main thread
    this._context.goToFrame(this._context.frameIndex);
    this._updateTracklets();
  }

  private async _updateTrackletMasks(
    data: AddPointsResult,
    updateThumbnails: boolean,
    shouldGoToFrame: boolean = true,
  ) {
    const {frameIndex, rleMaskList} = data;

    // 1. parse and decode masks for all objects
    for (const {objectId, rleMask} of rleMaskList) {
      const track = this._session.tracklets[objectId];
      const {size, counts} = rleMask;
      const rleObject: RLEObject = {
        size: [size[0], size[1]],
        counts: counts,
      };
      const isEmpty = counts === this._emptyMask?.counts;

      this._stats?.begin();

      const decodedMask = decode([rleObject]);
      const bbox = toBbox([rleObject]);

      const mask: Mask = {
        data: rleObject as RLEObject,
        shape: [...decodedMask.shape],
        bounds: [
          [bbox[0], bbox[1]],
          [bbox[0] + bbox[2], bbox[1] + bbox[3]],
        ],
        isEmpty,
      } as const;
      track.masks[frameIndex] = mask;

      if (updateThumbnails && !isEmpty) {
        const {ctx} = await this._compressMaskForCanvas(decodedMask);
        const frame = this._context.currentFrame as VideoFrame;
        await generateThumbnail(track, frameIndex, mask, frame, ctx);
      }
    }

    this._context.updateTracklets(
      frameIndex,
      Object.values(this._session.tracklets),
      shouldGoToFrame,
    );

    // Notify the main thread
    this._updateTracklets();
  }

  private _updateTracklets() {
    const tracklets: BaseTracklet[] = Object.values(
      this._session.tracklets,
    ).map(tracklet => {
      // Notify the main thread
      const {
        id,
        color,
        isInitialized,
        points: trackletPoints,
        thumbnail,
        masks,
      } = tracklet;
      return {
        id,
        color,
        isInitialized,
        points: trackletPoints,
        thumbnail,
        masks: masks.map(mask => ({
          shape: mask.shape,
          bounds: mask.bounds,
          isEmpty: mask.isEmpty,
        })),
      };
    });

    this._sendResponse<TrackletsUpdatedResponse>('trackletsUpdated', {
      tracklets,
    });
  }

  private _clearTrackletMasks() {
    const keys = Object.keys(this._session.tracklets);
    for (const key of keys) {
      const trackletId = Number(key);
      const tracklet = {...this._session.tracklets[trackletId], masks: []};
      this._session.tracklets[trackletId] = tracklet;
    }
    this._updateTracklets();
  }

  private async _compressMaskForCanvas(
    decodedMask: DataArray,
  ): Promise<{compressedData: Blob; ctx: OffscreenCanvasRenderingContext2D}> {
    const data = convertMaskToRGBA(decodedMask.data as Uint8Array);

    this._maskCanvas.width = decodedMask.shape[0];
    this._maskCanvas.height = decodedMask.shape[1];

    const imageData = new ImageData(
      data,
      decodedMask.shape[0],
      decodedMask.shape[1],
    );
    this._maskCtx.putImageData(imageData, 0, 0);

    const canvas = new OffscreenCanvas(
      decodedMask.shape[1],
      decodedMask.shape[0],
    );

    const ctx = canvas.getContext('2d');
    invariant(ctx != null, 'context cannot be null');
    ctx.save();
    ctx.rotate(Math.PI / 2);
    // Since the image was previously rotated 90° clockwise, after the image is rotated,
    // we scale the canvas's width using scaleY and height using scaleX.
    ctx.scale(1, -1);
    ctx.drawImage(this._maskCanvas, 0, 0);
    ctx.restore();

    const compressedData = await canvas.convertToBlob({type: 'image/png'});

    return {compressedData, ctx};
  }

  private async *_streamMasksForSession(
    abortController: AbortController,
    sessionId: string,
    startFrameIndex: undefined | number = 0,
    frameRange?: FrameRange,
  ): AsyncGenerator<StreamMasksResult | StreamMasksAbortResult, undefined> {
    const url = `${this._endpoint}/propagate_in_video`;

    const requestBody = {
      session_id: sessionId,
      start_frame_index: startFrameIndex,
      trim_start_frame: frameRange?.startFrame,
      trim_end_frame_exclusive: frameRange?.endFrameExclusive,
    };

    const headers: {[name: string]: string} = Object.assign({
      'Content-Type': 'application/json',
    });

    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers,
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `propagate_in_video failed with ${response.status}: ${errorText}`,
      );
    }

    const contentType = response.headers.get('Content-Type');
    if (
      contentType == null ||
      !contentType.startsWith('multipart/x-savi-stream;')
    ) {
      throw new Error(
        'endpoint needs to support Content-Type "multipart/x-savi-stream"',
      );
    }

    const responseBody = response.body;
    if (responseBody == null) {
      throw new Error('response body is null');
    }

    const reader = multipartStream(contentType, responseBody).getReader();

    const textDecoder = new TextDecoder();

    while (true) {
      if (abortController.signal.aborted) {
        reader.releaseLock();
        yield {aborted: true};
        return;
      }

      const {done, value} = await reader.read();
      if (done) {
        return;
      }

      const {headers, body} = value;

      const contentType = headers.get('Content-Type') as string;

      if (contentType.startsWith('application/json')) {
        const jsonResponse = JSON.parse(textDecoder.decode(body));
        const maskResults = jsonResponse.results;
        const rleMaskList = maskResults.map(
          (mask: {object_id: number; mask: RLEObject}) => {
            return {
              objectId: mask.object_id,
              rleMask: mask.mask,
            };
          },
        );
        yield {
          frameIndex: jsonResponse.frame_index,
          rleMaskList,
        };
      }
    }
  }

  private async _abortRequest(): Promise<void> {
    const sessionId = this._session.id;
    invariant(sessionId != null, 'session id cannot be empty');
    return new Promise((resolve, reject) => {
      try {
        commitMutation<SAM2ModelCancelPropagateInVideoMutation>(
          this._environment,
          {
            mutation: graphql`
              mutation SAM2ModelCancelPropagateInVideoMutation(
                $input: CancelPropagateInVideoInput!
              ) {
                cancelPropagateInVideo(input: $input) {
                  success
                }
              }
            `,
            variables: {
              input: {
                sessionId,
              },
            },
            onCompleted: response => {
              const {success} = response.cancelPropagateInVideo;
              if (!success) {
                reject(`could not abort session ${sessionId}`);
                return;
              }
              resolve();
            },
            onError: error => {
              Logger.error(error);
              reject(error);
            },
          },
        );
      } catch (error) {
        Logger.error(error);
        reject(error);
      }
    });
  }
}
