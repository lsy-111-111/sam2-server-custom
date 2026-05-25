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
import TrackletsAnnotation from '@/common/components/annotations/TrackletsAnnotation';
import useCloseSessionBeforeUnload from '@/common/components/session/useCloseSessionBeforeUnload';
import MessagesSnackbar from '@/common/components/snackbar/MessagesSnackbar';
import useMessagesSnackbar from '@/common/components/snackbar/useDemoMessagesSnackbar';
import {OBJECT_TOOLBAR_INDEX} from '@/common/components/toolbar/ToolbarConfig';
import useToolbarTabs from '@/common/components/toolbar/useToolbarTabs';
import VideoFilmstripWithPlayback from '@/common/components/video/VideoFilmstripWithPlayback';
import {
  FrameUpdateEvent,
  RenderingErrorEvent,
  SessionStartFailedEvent,
  SessionStartedEvent,
  TrackletsEvent,
  WorkerErrorEvent,
} from '@/common/components/video/VideoWorkerBridge';
import VideoEditor from '@/common/components/video/editor/VideoEditor';
import useResetDemoEditor from '@/common/components/video/editor/useResetEditor';
import useVideo from '@/common/components/video/editor/useVideo';
import InteractionLayer from '@/common/components/video/layers/InteractionLayer';
import {PointsLayer} from '@/common/components/video/layers/PointsLayer';
import {getErrorSummary, getRenderErrorSummary} from '@/common/error/ErrorUtils';
import LoadingStateScreen from '@/common/loading/LoadingStateScreen';
import UploadLoadingScreen from '@/common/loading/UploadLoadingScreen';
import useScreenSize from '@/common/screen/useScreenSize';
import {SegmentationPoint} from '@/common/tracker/Tracker';
import {
  activeTrackletObjectIdAtom,
  annotationExportSnapshotAtom,
  frameIndexAtom,
  isAddObjectEnabledAtom,
  isPlayingAtom,
  isPreviewVideo,
  isVideoLoadingAtom,
  pointsAtom,
  sessionAtom,
  streamingStateAtom,
  trackletObjectsAtom,
  uploadingStateAtom,
  VideoData,
} from '@/demo/atoms';
import useSettingsContext from '@/settings/useSettingsContext';
import {color, spacing} from '@/theme/tokens.stylex';
import stylex from '@stylexjs/stylex';
import {useAtom, useAtomValue, useSetAtom} from 'jotai';
import {useEffect, useState} from 'react';
import type {ErrorObject} from 'serialize-error';

const styles = stylex.create({
  container: {
    display: 'flex',
    flexDirection: 'column',
    overflow: 'auto',
    width: '100%',
    borderColor: color['gray-800'],
    backgroundColor: color['gray-800'],
    borderWidth: 8,
    borderRadius: 12,
    '@media screen and (max-width: 768px)': {
      // on mobile, we want to grow the editor container so that the editor
      // fills the remaining vertical space between the navbar and bottom
      // of the page
      flexGrow: 1,
      borderWidth: 0,
      borderRadius: 0,
      paddingBottom: spacing[4],
    },
  },
  loadingScreenWrapper: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    background: 'white',
    overflow: 'hidden',
    overflowY: 'auto',
    zIndex: 999,
  },
});

type Props = {
  video: VideoData;
};

export default function DemoVideoEditor({video: inputVideo}: Props) {
  const {settings} = useSettingsContext();
  const video = useVideo();
  const interactiveVideoPath =
    inputVideo.path != null && !isPreviewVideo(inputVideo)
      ? inputVideo.path
      : null;

  const [isSessionStartFailed, setIsSessionStartFailed] =
    useState<boolean>(false);
  const [sessionStartError, setSessionStartError] =
    useState<ErrorObject | null>(null);

  const [session, setSession] = useAtom(sessionAtom);

  const [activeTrackletId, setActiveTrackletObjectId] = useAtom(
    activeTrackletObjectIdAtom,
  );
  const setTrackletObjects = useSetAtom(trackletObjectsAtom);
  const setAnnotationExportSnapshot = useSetAtom(annotationExportSnapshotAtom);
  const setFrameIndex = useSetAtom(frameIndexAtom);
  const points = useAtomValue(pointsAtom);
  const isAddObjectEnabled = useAtomValue(isAddObjectEnabledAtom);
  const streamingState = useAtomValue(streamingStateAtom);
  const isPlaying = useAtomValue(isPlayingAtom);
  const isVideoLoading = useAtomValue(isVideoLoadingAtom);
  const uploadingState = useAtomValue(uploadingStateAtom);

  const [renderingError, setRenderingError] = useState<ErrorObject | null>(
    null,
  );
  const [videoRuntimeError, setVideoRuntimeError] = useState<ErrorObject | null>(
    null,
  );

  const {isMobile} = useScreenSize();

  const [tabIndex] = useToolbarTabs();
  const {enqueueMessage} = useMessagesSnackbar();

  useCloseSessionBeforeUnload();

  const {resetEditor, resetSession} = useResetDemoEditor();
  useEffect(() => {
    resetEditor();
    setIsSessionStartFailed(false);
    setSessionStartError(null);
    setRenderingError(null);
    setVideoRuntimeError(null);
  }, [inputVideo, resetEditor]);

  useEffect(() => {
    if (interactiveVideoPath == null) {
      return;
    }

    function onFrameUpdate(event: FrameUpdateEvent) {
      setFrameIndex(event.index);
    }

    // Listen to frame updates to fetch the frame index in the main thread,
    // which is then used downstream to render points per frame.
    video?.addEventListener('frameUpdate', onFrameUpdate);

    function onSessionStarted(event: SessionStartedEvent) {
      setIsSessionStartFailed(false);
      setSessionStartError(null);
      setAnnotationExportSnapshot(null);
      setSession({id: event.sessionId, ranPropagation: false});
    }

    video?.addEventListener('sessionStarted', onSessionStarted);

    function onSessionStartFailed(event: SessionStartFailedEvent) {
      setIsSessionStartFailed(true);
      setSessionStartError(event.error ?? null);
    }

    video?.addEventListener('sessionStartFailed', onSessionStartFailed);

    function onTrackletsUpdated(event: TrackletsEvent) {
      const tracklets = event.tracklets;
      if (tracklets.length === 0) {
        resetSession();
      }
      setTrackletObjects(tracklets);
    }

    video?.addEventListener('trackletsUpdated', onTrackletsUpdated);

    function onRenderingError(event: RenderingErrorEvent) {
      setVideoRuntimeError(null);
      setRenderingError(event.error);
    }

    video?.addEventListener('renderingError', onRenderingError);

    function onWorkerError(event: WorkerErrorEvent) {
      setVideoRuntimeError(event.error);
    }

    video?.addEventListener('error', onWorkerError);

    video?.initializeTracker('SAM 2', {
      inferenceEndpoint: settings.inferenceAPIEndpoint,
    });

    setAnnotationExportSnapshot(null);
    video?.startSession(interactiveVideoPath);

    return () => {
      const closeSessionPromise = video?.closeSession();
      void closeSessionPromise?.catch(() => {});
      video?.removeEventListener('frameUpdate', onFrameUpdate);
      video?.removeEventListener('sessionStarted', onSessionStarted);
      video?.removeEventListener('sessionStartFailed', onSessionStartFailed);
      video?.removeEventListener('trackletsUpdated', onTrackletsUpdated);
      video?.removeEventListener('renderingError', onRenderingError);
      video?.removeEventListener('error', onWorkerError);
    };
  }, [
    interactiveVideoPath,
    resetSession,
    setFrameIndex,
    setSession,
    setTrackletObjects,
    settings.inferenceAPIEndpoint,
    setAnnotationExportSnapshot,
    video,
  ]);

  async function handleOptimisticPointUpdate(newPoints: SegmentationPoint[]) {
    if (session == null) {
      return;
    }

    async function createActiveTracklet() {
      if (!isAddObjectEnabled || newPoints.length === 0) {
        return;
      }
      const tracklet = await video?.createTracklet();
      if (tracklet != null && newPoints.length > 0) {
        setActiveTrackletObjectId(tracklet.id);
        video?.updatePoints(tracklet.id, [newPoints[newPoints.length - 1]]);
      }
    }

    if (activeTrackletId != null) {
      video?.updatePoints(activeTrackletId, newPoints);
    } else {
      await createActiveTracklet();
    }
    enqueueMessage('pointClick');
  }

  async function handleAddPoint(point: SegmentationPoint) {
    if (streamingState === 'partial' || streamingState === 'requesting') {
      return;
    }
    if (isPlaying) {
      return video?.pause();
    }
    handleOptimisticPointUpdate([...points, point]);
  }

  function handleRemovePoint(point: SegmentationPoint) {
    if (
      isPlaying ||
      streamingState === 'partial' ||
      streamingState === 'requesting'
    ) {
      return;
    }
    handleOptimisticPointUpdate(points.filter(p => p !== point));
  }

  // The interaction layer handles clicks onto the video canvas. It is used
  // to get absolute point clicks within the video's coordinate system.
  // The PointsLayer handles rendering of input points and allows removing
  // individual points by clicking on them.
  const sessionStartFailureReason =
    sessionStartError != null
      ? getErrorSummary(sessionStartError)
      : 'The backend rejected the session start request.';
  const renderingFailureReason = getRenderErrorSummary(renderingError);
  const videoRuntimeFailureReason = getErrorSummary(videoRuntimeError);

  const layers = (
    <>
      {tabIndex === OBJECT_TOOLBAR_INDEX && (
        <>
          <InteractionLayer
            key="interaction-layer"
            onPoint={point => handleAddPoint(point)}
          />
          <PointsLayer
            key="points-layer"
            points={points}
            onRemovePoint={handleRemovePoint}
          />
        </>
      )}
      {!isMobile && <MessagesSnackbar key="snackbar-layer" />}
    </>
  );

  const showUploadOverlay =
    uploadingState !== 'default' && interactiveVideoPath != null;

  return (
    <>
      {isVideoLoading && !isSessionStartFailed && (
        <div {...stylex.props(styles.loadingScreenWrapper)}>
          <LoadingStateScreen
            title="Loading demo..."
            description="This may take a few moments, you're almost there!"
          />
        </div>
      )}
      {isSessionStartFailed && (
        <div {...stylex.props(styles.loadingScreenWrapper)}>
          <LoadingStateScreen
            title="Could not start the SAM 2 session."
            description="The page loaded, but the backend could not open a tracking session for this video."
            linkProps={{to: '..', label: 'Back to homepage'}}>
            <div className="rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-left text-sm text-[#4B5563]">
              <div>Reason: {sessionStartFailureReason}</div>
              <div className="mt-2 break-all">
                Inference API Endpoint:{' '}
                {settings.inferenceAPIEndpoint ||
                  '(same origin / proxied through frontend)'}
              </div>
            </div>
          </LoadingStateScreen>
        </div>
      )}
      {renderingError == null && videoRuntimeError != null && (
        <div {...stylex.props(styles.loadingScreenWrapper)}>
          <LoadingStateScreen
            title="The video worker reported an error."
            description="The page loaded, but the browser failed while fetching or preparing the video stream."
            linkProps={{to: '..', label: 'Back to homepage'}}>
            <div className="rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-left text-sm text-[#4B5563]">
              <div>Reason: {videoRuntimeFailureReason}</div>
              <div className="mt-2 break-all">
                Video API Endpoint:{' '}
                {settings.videoAPIEndpoint ||
                  '(same origin / proxied through frontend)'}
              </div>
            </div>
          </LoadingStateScreen>
        </div>
      )}
      {renderingError != null && (
        <div {...stylex.props(styles.loadingScreenWrapper)}>
          <LoadingStateScreen
            title="We hit a video rendering error."
            description="The app reached the editor, but the browser could not finish initializing the video renderer."
            linkProps={{to: '..', label: 'Back to homepage'}}>
            <div className="rounded-lg border border-black/10 bg-black/5 px-4 py-3 text-left text-sm text-[#4B5563]">
              <div>Reason: {renderingFailureReason}</div>
              {isMobile && (
                <div className="mt-2">
                  The current viewport is smaller than the desktop layout the demo
                  was designed for, so browser graphics limits can show up more
                  quickly on mobile-sized screens.
                </div>
              )}
            </div>
          </LoadingStateScreen>
        </div>
      )}
      {showUploadOverlay && (
        <div {...stylex.props(styles.loadingScreenWrapper)}>
          <UploadLoadingScreen />
        </div>
      )}
      <div {...stylex.props(styles.container)}>
        <VideoEditor video={inputVideo} layers={layers}>
          <div className="bg-graydark-800 w-full">
            <VideoFilmstripWithPlayback />
            <TrackletsAnnotation />
          </div>
        </VideoEditor>
      </div>
    </>
  );
}