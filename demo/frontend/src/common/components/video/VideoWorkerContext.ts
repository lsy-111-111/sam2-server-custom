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
  DecodedVideo,
  ImageFrame,
  decodeStream,
} from '@/common/codecs/VideoDecoder';
import {encode as encodeVideo} from '@/common/codecs/VideoEncoder';
import {
  Effect,
  EffectActionPoint,
  EffectFrameContext,
  EffectInit,
  EffectOptions,
} from '@/common/components/video/effects/Effect';
import BaseGLEffect from '@/common/components/video/effects/BaseGLEffect';
import EraseForegroundEffect from '@/common/components/video/effects/EraseForegroundEffect';
import AllEffects, {
  EffectIndex,
  Effects,
} from '@/common/components/video/effects/Effects';
import Overlay2DEffect from '@/common/components/video/effects/Overlay2DEffect';
import Logger from '@/common/logger/Logger';
import {FrameRange, Mask, SegmentationPoint, Tracklet} from '@/common/tracker/Tracker';
import {streamFile} from '@/common/utils/FileUtils';
import {Stats} from '@/debug/stats/Stats';
import {VIDEO_WATERMARK_TEXT} from '@/demo/DemoConfig';
import CreateFilmstripError from '@/graphql/errors/CreateFilmstripError';
import DrawFrameError from '@/graphql/errors/DrawFrameError';
import {RLEObject} from '@/jscocotools/mask';
import invariant from 'invariant';
import {CanvasForm} from 'pts';
import {serializeError} from 'serialize-error';

import {
  DecodeResponse,
  EffectUpdateResponse,
  EncodingCompletedResponse,
  EncodingStateUpdateResponse,
  FilmstripResponse,
  FrameUpdateResponse,
  PauseRequest,
  PlayRequest,
  RenderingErrorResponse,
  VideoWorkerResponse,
} from './VideoWorkerTypes';

const WEBGL_FALLBACK_EFFECTS = {
  Overlay: new Overlay2DEffect(),
  EraseForeground: new EraseForegroundEffect(),
} as const;

function getEvenlySpacedItems(decodedVideo: DecodedVideo, x: number) {
  const p = Math.floor(decodedVideo.numFrames / Math.max(1, x - 1));
  const middleFrames = decodedVideo.frames
    .slice(p, p * x)
    .filter(function (_, i) {
      return 0 == i % p;
    });
  return [
    decodedVideo.frames[0],
    ...middleFrames,
    decodedVideo.frames[decodedVideo.numFrames - 1],
  ];
}

export type FrameInfo = {
  tracklet: Tracklet;
  mask: Mask;
};

const WATERMARK_BOX_HORIZONTAL_PADDING = 10;
const WATERMARK_BOX_VERTICAL_PADDING = 10;

export type VideoStats = {
  fps?: Stats;
  videoFps?: Stats;
  total?: Stats;
  effect0?: Stats;
  effect1?: Stats;
  frameBmp?: Stats;
  maskBmp?: Stats;
  memory?: Stats;
};

export default class VideoWorkerContext {
  private _canvas: OffscreenCanvas | null = null;
  private _stats: VideoStats = {};
  private _ctx: OffscreenCanvasRenderingContext2D | null = null;
  private _form: CanvasForm | null = null;
  private _decodedVideo: DecodedVideo | null = null;
  private _frameIndex: number = 0;
  private _isPlaying: boolean = false;
  private _playbackRAFHandle: number | null = null;
  private _playbackTimeoutHandle: NodeJS.Timeout | null = null;
  private _isDrawing: boolean = false;
  private _glObjects: WebGL2RenderingContext | null = null;
  private _glBackground: WebGL2RenderingContext | null = null;
  private _canvasHighlights: OffscreenCanvas | null = null;
  private _canvasBackground: OffscreenCanvas | null = null;
  private _allowAnimation: boolean = false;
  private _currentSegmetationPoint: EffectActionPoint | null = null;

  private _effects: Effect[];
  private _effectNames: Array<keyof Effects>;
  private _supportsWorkerWebGL2: boolean;
  private _tracklets: Tracklet[] = [];

  public get width(): number {
    return this._decodedVideo?.width ?? 0;
  }

  public get height(): number {
    return this._decodedVideo?.height ?? 0;
  }

  public get frameIndex(): number {
    return this._frameIndex;
  }

  public get totalFrames(): number {
    return this._decodedVideo?.numFrames ?? this._decodedVideo?.frames.length ?? 0;
  }

  public get currentFrame(): VideoFrame | null {
    const frame = this._decodedVideo?.frames[this._clampFrameIndex(this._frameIndex)];
    return frame?.bitmap ?? null;
  }

  private _getDecodedFrameCount(): number {
    return this._decodedVideo?.frames.length ?? 0;
  }

  private _normalizeFrameRange(frameRange?: FrameRange): FrameRange {
    const totalFrames = Math.max(1, this.totalFrames);
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

  private _getSeekableFrameCount(): number {
    const decodedFrameCount = this._getDecodedFrameCount();
    if (decodedFrameCount < 1) {
      return 0;
    }
    return this._decodedVideo?.numFrames === decodedFrameCount
      ? this._decodedVideo.numFrames
      : decodedFrameCount;
  }

  private _clampFrameIndex(index: number): number {
    const seekableFrameCount = this._getSeekableFrameCount();
    if (seekableFrameCount < 1) {
      return 0;
    }
    return Math.min(Math.max(0, index), seekableFrameCount - 1);
  }

  constructor() {
    this._effectNames = ['Original', 'Overlay'];
    this._supportsWorkerWebGL2 = this._canUseWorkerWebGL2();
    this._effects = this._effectNames.map((name, index) => {
      return this._resolveEffectSelection(name, index as EffectIndex).effect;
    });

    // Loading watermark fonts. This is going to be async, but by the time of
    // video encoding, the fonts should be available.
    this._loadWatermarkFonts();
  }

  private _canUseWorkerWebGL2(): boolean {
    try {
      return new OffscreenCanvas(1, 1).getContext('webgl2') != null;
    } catch {
      return false;
    }
  }

  private _disposeWebGLContexts(): void {
    this._glObjects = null;
    this._glBackground = null;
    this._canvasHighlights = null;
    this._canvasBackground = null;
  }

  private _resolveEffectSelection(
    requestedName: keyof Effects,
    index: EffectIndex,
  ): {name: keyof Effects; effect: Effect} {
    if (this._supportsWorkerWebGL2) {
      return {
        name: requestedName,
        effect: AllEffects[requestedName],
      };
    }

    const effect = AllEffects[requestedName];
    if (!(effect instanceof BaseGLEffect)) {
      return {name: requestedName, effect};
    }

    if (index === EffectIndex.BACKGROUND) {
      return {
        name: 'Original',
        effect: AllEffects.Original,
      };
    }

    if (requestedName === 'EraseForeground') {
      return {
        name: 'EraseForeground',
        effect: WEBGL_FALLBACK_EFFECTS.EraseForeground,
      };
    }

    return {
      name: 'Overlay',
      effect: WEBGL_FALLBACK_EFFECTS.Overlay,
    };
  }

  private async _setupEffect(
    effect: Effect,
    index: EffectIndex,
    width: number,
    height: number,
  ): Promise<void> {
    if (effect instanceof BaseGLEffect) {
      const offCanvas =
        index === EffectIndex.BACKGROUND
          ? this._canvasBackground
          : this._canvasHighlights;
      invariant(offCanvas != null, 'need OffscreenCanvas to render effects');
      const webglContext =
        index === EffectIndex.BACKGROUND ? this._glBackground : this._glObjects;
      invariant(webglContext != null, 'need WebGL context to render effects');

      const init: EffectInit = {
        width,
        height,
        canvas: offCanvas,
        gl: webglContext,
      };
      await effect.setup(init);
      return;
    }

    await effect.setup({width, height});
  }

  private async _syncEffectsToRenderer(
    width: number,
    height: number,
  ): Promise<void> {
    for (let i = 0; i < this._effectNames.length; i++) {
      const index = i as EffectIndex;
      const currentEffect = this._effects[i];
      const {name, effect} = this._resolveEffectSelection(
        this._effectNames[i],
        index,
      );

      if (currentEffect !== effect) {
        await currentEffect.cleanup();
      }

      await this._setupEffect(effect, index, width, height);
      this._effects[i] = effect;
      this._effectNames[i] = name;

      this.sendResponse<EffectUpdateResponse>('effectUpdate', {
        name,
        index,
        variant: effect.variant,
        numVariants: effect.numVariants,
      });
    }
  }

  private initializeWebGLContext(width: number, height: number): boolean {
    if (!this._supportsWorkerWebGL2) {
      return false;
    }

    try {
      if (this._canvasHighlights == null && this._glObjects == null) {
        this._canvasHighlights = new OffscreenCanvas(width, height);
        this._glObjects = this._canvasHighlights.getContext('webgl2');
        if (this._glObjects == null) {
          this._supportsWorkerWebGL2 = false;
          this._disposeWebGLContexts();
          return false;
        }

        this._canvasHighlights.addEventListener(
          'webglcontextlost',
          event => {
            event.preventDefault();
            this._sendRenderingError(new Error('WebGL context lost.'));
          },
          false,
        );
      } else if (
        this._canvasHighlights != null &&
        (this._canvasHighlights.width !== width ||
          this._canvasHighlights.height !== height)
      ) {
        this._canvasHighlights.width = width;
        this._canvasHighlights.height = height;
        if (this._glObjects != null) {
          this._glObjects.viewport(0, 0, width, height);
        }
      }

      if (this._canvasBackground == null && this._glBackground == null) {
        this._canvasBackground = new OffscreenCanvas(width, height);
        this._glBackground = this._canvasBackground.getContext('webgl2');
        if (this._glBackground == null) {
          this._supportsWorkerWebGL2 = false;
          this._disposeWebGLContexts();
          return false;
        }

        this._canvasBackground.addEventListener(
          'webglcontextlost',
          event => {
            event.preventDefault();
            this._sendRenderingError(new Error('WebGL context lost.'));
          },
          false,
        );
      } else if (
        this._canvasBackground != null &&
        (this._canvasBackground.width != width ||
          this._canvasBackground.height != height)
      ) {
        this._canvasBackground.width = width;
        this._canvasBackground.height = height;
        if (this._glBackground != null) {
          this._glBackground.viewport(0, 0, width, height);
        }
      }

      return true;
    } catch {
      this._supportsWorkerWebGL2 = false;
      this._disposeWebGLContexts();
      return false;
    }
  }

  public setCanvas(canvas: OffscreenCanvas) {
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d');
    if (this._ctx == null) {
      throw new Error('Failed to initialize the OffscreenCanvas 2D context.');
    }
    this._form = new CanvasForm(this._ctx);
  }

  public setSource(src: string) {
    this.close();

    // Clear state of previous source.
    this.updateFrameIndex(0);
    this._tracklets = [];

    this._decodeVideo(src);
  }

  public goToFrame(index: number): void {
    if (this._getSeekableFrameCount() < 1) {
      return;
    }

    // Cancel any ongoing render
    this._cancelRender();
    this.updateFrameIndex(index);
    this._playbackRAFHandle = requestAnimationFrame(this._drawFrame.bind(this));
  }

  public play(): void {
    // Video already playing
    if (this._isPlaying) {
      return;
    }

    // Cannot playback without frames
    if (this._decodedVideo === null) {
      throw new Error('no decoded video');
    }

    if (this._getSeekableFrameCount() < 2) {
      return;
    }

    const {fps} = this._decodedVideo;
    const timePerFrame = 1000 / (fps ?? 30);
    let startTime: number | null = null;
    // The offset frame index compensates for cases where the video playback
    // does not start at frame index 0.
    const offsetFrameIndex = this._clampFrameIndex(this._frameIndex);

    const updateFrame = (time: number) => {
      if (startTime === null) {
        startTime = time;
      }

      this._stats.fps?.begin();

      const seekableFrameCount = this._getSeekableFrameCount();
      if (seekableFrameCount < 2) {
        this._stats.fps?.end();
        this._playbackRAFHandle = requestAnimationFrame(updateFrame);
        return;
      }

      const diff = time - startTime;
      const expectedFrame =
        (Math.floor(diff / timePerFrame) + offsetFrameIndex) %
        seekableFrameCount;

      if (this._frameIndex !== expectedFrame && !this._isDrawing) {
        // Update to the next expected frame
        this.updateFrameIndex(expectedFrame);
        this._drawFrame();
      }

      this._playbackRAFHandle = requestAnimationFrame(updateFrame);

      this._stats.fps?.end();
    };

    this.updatePlayback(true);
    this._playbackRAFHandle = requestAnimationFrame(updateFrame);
  }

  public pause(): void {
    this.updatePlayback(false);
    this._cancelRender();
  }

  public stop(): void {
    this.pause();
    this.updateFrameIndex(0);
  }

  public async createFilmstrip(width: number, height: number): Promise<void> {
    if (width < 1 || height < 1) {
      Logger.warn(
        `Cannot create filmstrip because width ${width} or height ${height} is too small.`,
      );
      return;
    }

    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');

      if (this._decodedVideo !== null) {
        const scale = canvas.height / this._decodedVideo.height;
        const resizeWidth = this._decodedVideo.width * scale;

        const spacedFrames = getEvenlySpacedItems(
          this._decodedVideo,
          Math.ceil(canvas.width / resizeWidth),
        );

        spacedFrames.forEach((frame, idx) => {
          if (frame != null) {
            ctx?.drawImage(
              frame.bitmap,
              resizeWidth * idx,
              0,
              resizeWidth,
              canvas.height,
            );
          }
        });
      }

      const filmstrip = await createImageBitmap(canvas);

      this.sendResponse<FilmstripResponse>(
        'filmstrip',
        {
          filmstrip,
        },
        [filmstrip],
      );
    } catch {
      this._sendRenderingError(
        new CreateFilmstripError('Failed to create filmstrip'),
      );
    }
  }

  public async setEffect(
    name: keyof Effects,
    index: EffectIndex,
    options?: EffectOptions,
  ): Promise<void> {
    const currentEffect = this._effects[index];
    const {name: resolvedName, effect} = this._resolveEffectSelection(
      name,
      index,
    );

    if (currentEffect !== effect) {
      await currentEffect.cleanup();

      if (this._decodedVideo != null) {
        await this._setupEffect(
          effect,
          index,
          this._decodedVideo.width,
          this._decodedVideo.height,
        );
      }
    }

    if (options != null) {
      await effect.update(options);
    }

    this.sendResponse<EffectUpdateResponse>('effectUpdate', {
      name: resolvedName,
      index,
      variant: effect.variant,
      numVariants: effect.numVariants,
    });

    this._effectNames[index] = resolvedName;
    this._effects[index] = effect;
    this._playbackRAFHandle = requestAnimationFrame(this._drawFrame.bind(this));
  }

  async encode(frameRange?: FrameRange) {
    const decodedVideo = this._decodedVideo;
    invariant(
      decodedVideo !== null,
      'cannot encode video because there is no decoded video available',
    );
    invariant(
      decodedVideo.frames.length === decodedVideo.numFrames,
      'cannot encode video because decoding is not complete',
    );

    const canvas = new OffscreenCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d', {willReadFrequently: true});
    invariant(
      ctx !== null,
      'cannot encode video because failed to construct offscreen canvas context',
    );

    const form = new CanvasForm(ctx);
    const normalizedFrameRange = this._normalizeFrameRange(frameRange);
    const frameCount =
      normalizedFrameRange.endFrameExclusive - normalizedFrameRange.startFrame;

    const file = await encodeVideo(
      this.width,
      this.height,
      frameCount,
      this._framesGenerator(decodedVideo, canvas, form, normalizedFrameRange),
      progress => {
        this.sendResponse<EncodingStateUpdateResponse>('encodingStateUpdate', {
          progress,
        });
      },
    );
    this.sendResponse<EncodingCompletedResponse>(
      'encodingCompleted',
      {
        file,
      },
      [file],
    );
  }

  private async *_framesGenerator(
    decodedVideo: DecodedVideo,
    canvas: OffscreenCanvas,
    form: CanvasForm,
    frameRange: FrameRange,
  ): AsyncGenerator<ImageFrame, undefined> {
    const frames = decodedVideo.frames;
    const firstFrame = frames[frameRange.startFrame];
    const timestampOffset = firstFrame?.timestamp ?? 0;

    for (
      let frameIndex = frameRange.startFrame;
      frameIndex < frameRange.endFrameExclusive;
      ++frameIndex
    ) {
      await this._drawFrameImpl(form, frameIndex, true);

      const frame = frames[frameIndex];
      const shiftedTimestamp = Math.max(0, frame.timestamp - timestampOffset);
      const videoFrame = new VideoFrame(canvas, {
        timestamp: shiftedTimestamp,
      });

      yield {
        bitmap: videoFrame,
        timestamp: shiftedTimestamp,
        duration: frame.duration,
      };

      videoFrame.close();
    }
  }

  public enableStats() {
    this._stats.fps = new Stats('fps');
    this._stats.videoFps = new Stats('fps', 'V');
    this._stats.total = new Stats('ms', 'T');
    this._stats.effect0 = new Stats('ms', 'B');
    this._stats.effect1 = new Stats('ms', 'H');
    this._stats.frameBmp = new Stats('ms', 'F');
    this._stats.maskBmp = new Stats('ms', 'M');
    this._stats.memory = new Stats('memory');
  }

  public allowEffectAnimation(
    allow: boolean = true,
    objectId?: number,
    points?: SegmentationPoint[],
  ) {
    if (objectId != null && points != null && points.length) {
      const last_point_position = points[points.length - 1];
      this._currentSegmetationPoint = {
        objectId,
        position: [last_point_position[0], last_point_position[1]],
      };
    }

    if (!allow) {
      this._currentSegmetationPoint = null;
    }

    this._allowAnimation = allow;
  }

  public close(): void {
    // Clear any frame content
    this._ctx?.reset();

    // Close frames of previously decoded video.
    this._decodedVideo?.frames.forEach(f => f.bitmap.close());
    this._decodedVideo = null;
  }

  // TRACKER

  public updateTracklets(
    frameIndex: number,
    tracklets: Tracklet[],
    shouldGoToFrame: boolean = true,
  ): void {
    this._tracklets = tracklets;
    if (shouldGoToFrame) {
      this.goToFrame(frameIndex);
    }
  }

  public clearTrackletMasks(tracklet: Tracklet): void {
    this._tracklets = this._tracklets.filter(t => t.id != tracklet.id);
  }

  public clearMasks(): void {
    this._tracklets = [];
  }

  // PRIVATE FUNCTIONS

  private sendResponse<T extends VideoWorkerResponse>(
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

  private async _decodeVideo(src: string): Promise<void> {
    const canvas = this._canvas;
    invariant(canvas != null, 'need canvas to render decoded video');

    this.sendResponse('loadstart');

    const fileStream = streamFile(src, {
      credentials: 'same-origin',
      cache: 'no-store',
    });

    let renderedFirstFrame = false;
    this._decodedVideo = await decodeStream(fileStream, async progress => {
      const {fps, height, width, numFrames, frames} = progress;
      this._decodedVideo = progress;
      if (!renderedFirstFrame) {
        renderedFirstFrame = true;
        canvas.width = width;
        canvas.height = height;
        this.initializeWebGLContext(width, height);
        await this._syncEffectsToRenderer(width, height);

        // Need to render frame immediately. Cannot go through
        // requestAnimationFrame because then rendering this frame would be
        // delayed until the full video has finished decoding.
        this._drawFrame();

        this._stats.videoFps?.updateMaxValue(fps);
        this._stats.total?.updateMaxValue(1000 / fps);
        this._stats.effect0?.updateMaxValue(1000 / fps);
        this._stats.effect1?.updateMaxValue(1000 / fps);
        this._stats.frameBmp?.updateMaxValue(1000 / fps);
        this._stats.maskBmp?.updateMaxValue(1000 / fps);
      }
      this.sendResponse<DecodeResponse>('decode', {
        totalFrames: numFrames,
        numFrames: frames.length,
        fps: fps,
        width: width,
        height: height,
        done: false,
      });
    });

    if (!renderedFirstFrame) {
      canvas.width = this._decodedVideo.width;
      canvas.height = this._decodedVideo.height;
      this.initializeWebGLContext(
        this._decodedVideo.width,
        this._decodedVideo.height,
      );
      await this._syncEffectsToRenderer(
        this._decodedVideo.width,
        this._decodedVideo.height,
      );
      this._drawFrame();
    }

    this.sendResponse<DecodeResponse>('decode', {
      totalFrames: this._decodedVideo.numFrames,
      numFrames: this._decodedVideo.frames.length,
      fps: this._decodedVideo.fps,
      width: this._decodedVideo.width,
      height: this._decodedVideo.height,
      done: true,
    });
  }

  private _drawFrame(): void {
    if (this._canvas !== null && this._form !== null) {
      this._drawFrameImpl(this._form, this._frameIndex);
    }
  }

  private async _drawFrameImpl(
    form: CanvasForm,
    frameIndex: number,
    enableWatermark: boolean = false,
    step: number = 0,
    maxSteps: number = 40,
  ): Promise<void> {
    if (this._decodedVideo === null) {
      return;
    }

    {
      this._stats.videoFps?.begin();
      this._stats.total?.begin();
      this._stats.memory?.begin();
    }

    try {
      const frame = this._decodedVideo.frames[frameIndex];
      if (frame == null) {
        this._stats.videoFps?.end();
        this._stats.total?.end();
        this._stats.memory?.end();
        this._isDrawing = false;
        return;
      }
      const {bitmap} = frame;

      this._stats.frameBmp?.begin();

      // Need to convert VideoFrame to ImageBitmap because Safari can only apply
      // globalCompositeOperation on ImageBitmap and fails on VideoFrame. FWIW,
      // Chrome treats VideoFrame similarly to ImageBitmap.
      const frameBitmap = await createImageBitmap(bitmap);

      this._stats.frameBmp?.end();

      const masks: Mask[] = [];
      const colors: string[] = [];
      const tracklets: Tracklet[] = [];
      this._tracklets.forEach(tracklet => {
        const mask = tracklet.masks[frameIndex];
        if (mask != null) {
          masks.push(mask);
          tracklets.push(tracklet);
          colors.push(tracklet.color);
        }
      });
      const effectActionPoint = this._currentSegmetationPoint;

      this._stats.maskBmp?.begin();

      const effectMaskPromises = masks.map(async ({data, bounds}) => {
        return {
          bounds,
          bitmap: data as RLEObject,
        };
      });
      const effectMasks = await Promise.all(effectMaskPromises);

      this._stats.maskBmp?.end();

      form.ctx.fillStyle = 'rgba(0, 0, 0, 0)';
      form.ctx.fillRect(0, 0, this.width, this.height);

      const effectParams: EffectFrameContext = {
        frame: frameBitmap,
        masks: effectMasks,
        maskColors: colors,
        frameIndex: frameIndex,
        totalFrames: this._decodedVideo.frames.length,
        fps: this._decodedVideo.fps,
        width: frameBitmap.width,
        height: frameBitmap.height,
        actionPoint: null,
      };

      // Allows animation within a single frame.
      if (this._allowAnimation && step < maxSteps) {
        const animationDuration = 2; // Total duration of the animation in seconds
        const progress = step / maxSteps;
        const timeParameter = progress * animationDuration;
        // Pass dynamic effect params
        effectParams.timeParameter = timeParameter;
        effectParams.actionPoint = effectActionPoint;

        this._processEffects(form, effectParams, tracklets);

        // Use RAF to draw frame, and update the display,
        // this avoids to wait until the javascript call stack is cleared.
        requestAnimationFrame(() =>
          this._drawFrameImpl(form, frameIndex, false, step + 1, maxSteps),
        );
      } else {
        this._processEffects(form, effectParams, tracklets);
      }

      if (enableWatermark) {
        this._drawWatermark(form, frameBitmap);
      }

      // Do not simply drop the JavaScript reference to the ImageBitmap; doing so
      // will keep its graphics resource alive until the next time the garbage
      // collector runs.
      frameBitmap.close();

      {
        this._stats.videoFps?.end();
        this._stats.total?.end();
        this._stats.memory?.end();
      }

      this._isDrawing = false;
    } catch (error) {
      const message =
        error instanceof Error && error.message.length > 0
          ? error.message
          : 'Failed to draw frame';
      this._sendRenderingError(new DrawFrameError(message));
    }
  }

  private _drawWatermark(form: CanvasForm, frameBitmap: ImageBitmap): void {
    const frameWidth = this._canvas?.width || frameBitmap.width;
    const frameHeight = this._canvas?.height || frameBitmap.height;
    // Font size is either 12 or smaller based on available width
    // since the font is not monospaced, we approximate it'll fit 1.5 more characters than monospaced
    const approximateFontSize = Math.min(
      Math.floor(frameWidth / (VIDEO_WATERMARK_TEXT.length / 1.5)),
      12,
    );

    form.ctx.font = `${approximateFontSize}px "Inter", sans-serif`;
    const measureGeneratedBy = form.ctx.measureText(VIDEO_WATERMARK_TEXT);

    const textBoxWidth =
      measureGeneratedBy.width + 2 * WATERMARK_BOX_HORIZONTAL_PADDING;
    const textBoxHeight =
      measureGeneratedBy.actualBoundingBoxAscent +
      2 * WATERMARK_BOX_VERTICAL_PADDING;
    const textBoxX = frameWidth - textBoxWidth;
    const textBoxY = frameHeight - textBoxHeight;

    form.ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    form.ctx.beginPath();
    form.ctx.roundRect(
      Math.round(textBoxX),
      Math.round(textBoxY),
      Math.round(textBoxWidth),
      Math.round(textBoxHeight),
      [WATERMARK_BOX_HORIZONTAL_PADDING, 0, 0, 0],
    );
    form.ctx.fill();

    // Always reset the text style because some effects may change text styling in the same ctx
    form.ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    form.ctx.textAlign = 'left';

    form.ctx.fillText(
      VIDEO_WATERMARK_TEXT,
      Math.round(textBoxX + WATERMARK_BOX_HORIZONTAL_PADDING),
      Math.round(
        textBoxY +
          WATERMARK_BOX_VERTICAL_PADDING +
          measureGeneratedBy.actualBoundingBoxAscent,
      ),
    );
  }

  private updateFrameIndex(index: number): void {
    this._frameIndex = this._clampFrameIndex(index);
    this.sendResponse<FrameUpdateResponse>('frameUpdate', {
      index: this._frameIndex,
    });
  }

  private _loadWatermarkFonts() {
    const requiredFonts = [
      {
        url: '/fonts/Inter-VariableFont.ttf',
        format: 'truetype-variations',
      },
    ];
    requiredFonts.forEach(requiredFont => {
      const fontFace = new FontFace(
        'Inter',
        `url(${requiredFont.url}) format('${requiredFont.format}')`,
      );
      fontFace.load().then(font => {
        self.fonts.add(font);
      });
    });
  }

  private updatePlayback(playing: boolean): void {
    if (playing) {
      this.sendResponse<PlayRequest>('play');
    } else {
      this.sendResponse<PauseRequest>('pause');
    }
    this._isPlaying = playing;
  }

  private _cancelRender(): void {
    if (this._playbackTimeoutHandle !== null) {
      clearTimeout(this._playbackTimeoutHandle);
      this._playbackTimeoutHandle = null;
    }
    if (this._playbackRAFHandle !== null) {
      cancelAnimationFrame(this._playbackRAFHandle);
      this._playbackRAFHandle = null;
    }
  }

  private _sendRenderingError(error: Error): void {
    this.sendResponse<RenderingErrorResponse>('renderingError', {
      error: serializeError(error),
    });
  }

  private _processEffects(
    form: CanvasForm,
    effectParams: EffectFrameContext,
    tracklets: Tracklet[],
  ) {
    for (let i = 0; i < this._effects.length; i++) {
      const effect = this._effects[i];

      if (i === 0) {
        this._stats.effect0?.begin();
      } else if (i === 1) {
        this._stats.effect1?.begin();
      }

      effect.apply(form, effectParams, tracklets);

      if (i === 0) {
        this._stats.effect0?.end();
      } else if (i === 1) {
        this._stats.effect1?.end();
      }
    }
  }
}
