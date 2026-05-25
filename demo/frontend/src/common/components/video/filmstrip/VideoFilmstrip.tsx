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
import SelectedFrameHelper from '@/common/components/video/filmstrip/SelectedFrameHelper';
import {
  DEFAULT_TRIM_RANGE,
  TrimRange,
  clampTrimRange,
  annotationExportSnapshotAtom,
  isPlayingAtom,
  trimRangeAtom,
} from '@/demo/atoms';
import stylex from '@stylexjs/stylex';
import {useAtom, useAtomValue, useSetAtom} from 'jotai';
import {CanvasSpace, Pt} from 'pts';
import {useCallback, useEffect, useMemo, useRef} from 'react';
import {PtsCanvas, PtsCanvasImperative} from 'react-pts-canvas';
import {VideoRef} from '../Video';
import {DecodeEvent, FrameUpdateEvent} from '../VideoWorkerBridge';
import useVideo from '../editor/useVideo';
import {
  drawFilmstrip,
  drawMarker,
  drawTrimRange,
  getPointerPosition,
  getTimeFromFrame,
} from './FilmstripUtil';
import {selectedFrameHelperAtom} from './atoms';
import useDisableScrolling from './useDisableScrolling';

const styles = stylex.create({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  filmstripWrapper: {
    position: 'relative',
    width: '100%',
    height: '5rem' /* 80px */,
  },
  filmstrip: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    cursor: 'col-resize',
    overflow: 'hidden',
  },
  canvas: {
    width: '100%',
    height: '100%',
  },
  trimMeta: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '0.75rem',
    color: '#9CA3AF',
    fontSize: '0.75rem',
    lineHeight: '1rem',
    fontFamily: 'monospace',
  },
});

export const PADDING_TOP = 30;
export const PADDING_BOTTOM = 0;

type TrimHandle = 'end';

export default function VideoFilmstrip() {
  const video = useVideo();
  const ptsCanvasRef = useRef<PtsCanvasImperative | null>(null);
  const filmstripRef = useRef<ImageBitmap | null>(null);
  const isPlayingOnPointerDownRef = useRef<boolean>(false);
  const isPlaying = useAtomValue(isPlayingAtom);
  const [trimRange, setTrimRange] = useAtom(trimRangeAtom);
  const setAnnotationExportSnapshot = useSetAtom(annotationExportSnapshotAtom);

  const {enable: enableScrolling, disable: disableScrolling} =
    useDisableScrolling();

  const pointerPositionRef = useRef<Pt | null>(null);
  const animateRAFHandle = useRef<number | null>(null);
  const draggingTrimHandleRef = useRef<TrimHandle | null>(null);
  const pendingTrimRangeRef = useRef<TrimRange | null>(null);
  const trimRangeRef = useRef<TrimRange>(trimRange);

  const selectedFrameHelper = useMemo(() => new SelectedFrameHelper(1, 1), []);
  const setSelectedFrameHelper = useSetAtom(selectedFrameHelperAtom);

  const fpsRef = useRef<number>(30);

  useEffect(() => {
    trimRangeRef.current = trimRange;
  }, [trimRange]);

  useEffect(() => {
    function onDecode(event: DecodeEvent) {
      fpsRef.current = event.fps;
      setTrimRange(previousRange => {
        if (event.totalFrames <= 0) {
          return previousRange;
        }
        if (
          previousRange.startFrame === 0 &&
          previousRange.endFrameExclusive === 1 &&
          event.totalFrames > 1
        ) {
          return {startFrame: 0, endFrameExclusive: event.totalFrames};
        }
        return clampTrimRange(previousRange, event.totalFrames);
      });
    }
    video?.addEventListener('decode', onDecode);
    return () => {
      video?.removeEventListener('decode', onDecode);
    };
  }, [setTrimRange, video]);

  useEffect(() => {
    setSelectedFrameHelper(selectedFrameHelper);
  }, [setSelectedFrameHelper, selectedFrameHelper]);

  const getSeekableFrameCount = useCallback((videoRef: VideoRef | null) => {
    if (videoRef == null) {
      return 1;
    }

    if (videoRef.isDecodeComplete) {
      return Math.max(1, videoRef.numberOfFrames);
    }

    return Math.max(1, videoRef.decodedFrameCount);
  }, []);

  const computeFrame = useCallback(
    (normalizedPosition: number): {index: number} | null => {
      if (video == null) {
        return null;
      }

      const numFrames = getSeekableFrameCount(video);
      const index = Math.min(
        Math.max(0, Math.floor(normalizedPosition * numFrames)),
        numFrames - 1,
      );
      return {index};
    },
    [getSeekableFrameCount, video],
  );

  const computeBoundaryFrame = useCallback(
    (normalizedPosition: number): number => {
      const numFrames = getSeekableFrameCount(video);
      return Math.min(
        Math.max(0, Math.round(normalizedPosition * numFrames)),
        numFrames,
      );
    },
    [getSeekableFrameCount, video],
  );

  const createFilmstrip = useCallback(
    async (
      video: VideoRef | null,
      space: CanvasSpace | undefined,
      frameIndex?: number,
    ) => {
      if (video === null || space == undefined) {
        return;
      }

      const bitmap: ImageBitmap = await video?.createFilmstrip(
        space.width,
        space.height - (PADDING_TOP - PADDING_BOTTOM),
      );

      filmstripRef.current = bitmap;

      const seekableFrameCount = getSeekableFrameCount(video);
      const clampedFrameIndex =
        frameIndex == null
          ? undefined
          : Math.min(frameIndex, seekableFrameCount - 1);
      selectedFrameHelper.reset(
        seekableFrameCount,
        space.width,
        clampedFrameIndex,
      );

      return bitmap;
    },
    [getSeekableFrameCount, selectedFrameHelper],
  );

  const handleAnimate = useCallback(() => {
    if (animateRAFHandle.current === null) {
      animateRAFHandle.current = requestAnimationFrame(() => {
        animateRAFHandle.current = null;
        const space = ptsCanvasRef.current?.getSpace();
        const form = ptsCanvasRef.current?.getForm();
        if (space == undefined || form == undefined) {
          return;
        }

        space.clear();
        drawFilmstrip(filmstripRef.current, space, form);
        drawTrimRange(
          space,
          form,
          selectedFrameHelper,
          trimRangeRef.current,
          fpsRef.current,
        );

        const scanLabel =
          selectedFrameHelper.isScanning &&
          pointerPositionRef.current !== null &&
          fpsRef.current !== null &&
          getTimeFromFrame(
            computeFrame(pointerPositionRef.current.x / space.width)?.index ?? 0,
            fpsRef.current,
          );

        drawMarker(
          space,
          form,
          selectedFrameHelper,
          pointerPositionRef.current,
          scanLabel,
          fpsRef.current,
        );
      });
    }
  }, [computeFrame, selectedFrameHelper]);

  const getTrimHandle = useCallback(
    (position: Pt, space: CanvasSpace): TrimHandle | null => {
      const endX = selectedFrameHelper.toPosition(trimRangeRef.current.endFrameExclusive);
      const handleHitSlop = 10;
      if (Math.abs(position.x - endX) > handleHitSlop) {
        return null;
      }
      if (position.y < PADDING_TOP || position.y > space.height - PADDING_BOTTOM) {
        return null;
      }
      return 'end';
    },
    [selectedFrameHelper],
  );

  const updatePendingTrimRange = useCallback(
    (position: Pt, space: CanvasSpace) => {
      const handle = draggingTrimHandleRef.current;
      if (handle == null) {
        return;
      }
      const boundaryFrame = computeBoundaryFrame(position.x / space.width);
      const totalFrames = getSeekableFrameCount(video);
      const nextRange = clampTrimRange(
        {
          startFrame: 0,
          endFrameExclusive: Math.max(boundaryFrame, 1),
        },
        totalFrames,
      );
      pendingTrimRangeRef.current = nextRange;
      trimRangeRef.current = nextRange;
      setTrimRange(nextRange);
      handleAnimate();
    },
    [computeBoundaryFrame, getSeekableFrameCount, handleAnimate, setTrimRange, video],
  );

  const commitPendingTrimRange = useCallback(() => {
    const pendingRange = pendingTrimRangeRef.current;
    pendingTrimRangeRef.current = null;
    draggingTrimHandleRef.current = null;
    if (pendingRange == null || video == null) {
      return;
    }

    const nextRange = clampTrimRange(pendingRange, getSeekableFrameCount(video));
    setTrimRange(nextRange);
    trimRangeRef.current = nextRange;
    setAnnotationExportSnapshot(null);
    if (isPlayingOnPointerDownRef.current) {
      video.play();
    }
    handleAnimate();
  }, [getSeekableFrameCount, handleAnimate, setAnnotationExportSnapshot, setTrimRange, video]);

  const handleFrameUpdate = useCallback(
    (event: FrameUpdateEvent) => {
      if (!selectedFrameHelper.isScanning) {
        selectedFrameHelper.select(event.index);
      }
      handleAnimate();
    },
    [handleAnimate, selectedFrameHelper],
  );

  useEffect(() => {
    video?.addEventListener('frameUpdate', handleFrameUpdate);
    return () => {
      video?.removeEventListener('frameUpdate', handleFrameUpdate);
    };
  }, [video, handleFrameUpdate]);

  useEffect(() => {
    const space = ptsCanvasRef.current?.getSpace();

    async function onLoadStart() {
      trimRangeRef.current = DEFAULT_TRIM_RANGE;
      setTrimRange(DEFAULT_TRIM_RANGE);
      await createFilmstrip(video, space, 0);
      handleAnimate();
    }

    async function progress(event?: DecodeEvent) {
      await createFilmstrip(video, space, 0);
      if (event?.totalFrames != null && event.totalFrames > 0) {
        const clampedRange = clampTrimRange(trimRangeRef.current, event.totalFrames);
        trimRangeRef.current = clampedRange;
        setTrimRange(clampedRange);
      }
      handleAnimate();
    }

    void progress();

    video?.addEventListener('loadstart', onLoadStart);
    video?.addEventListener('decode', progress);

    return () => {
      video?.removeEventListener('loadstart', onLoadStart);
      video?.removeEventListener('decode', progress);
    };
  }, [createFilmstrip, selectedFrameHelper, handleAnimate, setTrimRange, video]);

  const selectedDurationFrames = Math.max(
    1,
    trimRange.endFrameExclusive - trimRange.startFrame,
  );

  return (
    <div {...stylex.props(styles.container)}>
      <div {...stylex.props(styles.filmstripWrapper)}>
        <div {...stylex.props(styles.filmstrip)}>
          <PtsCanvas
            {...stylex.props(styles.canvas)}
            ref={ptsCanvasRef}
            background="transparent"
            resize={true}
            refresh={false}
            play={false}
            onPtsResize={async space => {
              if (video != null && space != undefined) {
                selectedFrameHelper.reset(
                  getSeekableFrameCount(video),
                  space.width,
                );
              }
              if (video !== null) {
                await createFilmstrip(video, space);
              }
              handleAnimate();
            }}
            onPointerDown={event => {
              const canvas = ptsCanvasRef.current?.getCanvas();
              canvas?.setPointerCapture(event.pointerId);
              disableScrolling();
              pointerPositionRef.current = getPointerPosition(event);
              isPlayingOnPointerDownRef.current = isPlaying;
              if (isPlaying) {
                video?.pause();
              }

              const space = ptsCanvasRef.current?.getSpace();
              if (space != null) {
                const trimHandle = getTrimHandle(pointerPositionRef.current, space);
                if (trimHandle != null) {
                  draggingTrimHandleRef.current = trimHandle;
                  pendingTrimRangeRef.current = trimRangeRef.current;
                  updatePendingTrimRange(pointerPositionRef.current, space);
                  return;
                }
              }

              selectedFrameHelper.scan(true);
            }}
            onPointerUp={event => {
              enableScrolling();

              const space = ptsCanvasRef.current?.getSpace();
              pointerPositionRef.current = getPointerPosition(event);

              if (draggingTrimHandleRef.current != null) {
                if (space != undefined) {
                  updatePendingTrimRange(pointerPositionRef.current, space);
                }
                void commitPendingTrimRange();
                pointerPositionRef.current = null;
                return;
              }

              if (space != undefined) {
                selectedFrameHelper.scan(false);
                const frame = computeFrame(
                  pointerPositionRef.current.x / space.size.x,
                );
                if (
                  frame != null &&
                  selectedFrameHelper.index !== frame.index
                ) {
                  selectedFrameHelper.select(frame.index);
                  if (video !== null) {
                    video.frame = frame.index;
                    if (isPlayingOnPointerDownRef.current) {
                      video.play();
                    }
                  }
                }
                handleAnimate();
              }

              pointerPositionRef.current = null;
            }}
            onPointerMove={event => {
              const space = ptsCanvasRef.current?.getSpace();
              if (space == null) {
                return;
              }

              pointerPositionRef.current = getPointerPosition(event);

              if (draggingTrimHandleRef.current != null) {
                updatePendingTrimRange(pointerPositionRef.current, space);
                return;
              }

              if (!selectedFrameHelper.isScanning) {
                return;
              }

              const frame = computeFrame(
                pointerPositionRef.current.x / space.size.x,
              );
              if (frame != null) {
                handleAnimate();
                if (video !== null) {
                  video.frame = frame.index;
                }
              }
            }}
          />
        </div>
      </div>
      <div {...stylex.props(styles.trimMeta)}>
        <span>Start {getTimeFromFrame(trimRange.startFrame, fpsRef.current)}</span>
        <span>Length {getTimeFromFrame(selectedDurationFrames, fpsRef.current)}</span>
        <span>End {getTimeFromFrame(Math.max(trimRange.startFrame, trimRange.endFrameExclusive - 1), fpsRef.current)}</span>
      </div>
    </div>
  );
}
