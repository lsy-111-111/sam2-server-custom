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
import Toolbar from '@/common/components/toolbar/Toolbar';
import UploadPreviewPlayer from '@/common/components/upload/UploadPreviewPlayer';
import type {UploadPreviewMode} from '@/common/components/upload/UploadPreviewMode';
import UploadPreviewSidebar from '@/common/components/upload/UploadPreviewSidebar';
import useUploadSession from '@/common/components/upload/useUploadSession';
import DemoVideoEditor from '@/common/components/video/editor/DemoVideoEditor';
import useInputVideo from '@/common/components/video/useInputVideo';
import StatsView from '@/debug/stats/StatsView';
import {createReadyVideoData, isPreviewVideo, VideoData} from '@/demo/atoms';
import DemoPageLayout from '@/layouts/DemoPageLayout';
import {DemoPageQuery} from '@/routes/__generated__/DemoPageQuery.graphql';
import {useCallback, useEffect, useMemo, useState} from 'react';
import {graphql, useLazyLoadQuery} from 'react-relay';
import {Location, useLocation, useNavigate} from 'react-router-dom';

type LocationState = {
  video?: VideoData;
};

export default function DemoPage() {
  const navigate = useNavigate();
  const location = useLocation() as Location<LocationState>;
  const {state} = location;
  const data = useLazyLoadQuery<DemoPageQuery>(
    graphql`
      query DemoPageQuery {
        defaultVideo {
          path
          posterPath
          url
          posterUrl
          height
          width
        }
      }
    `,
    {},
  );
  const {setInputVideo} = useInputVideo();
  const {uploadSession, clearUploadSession, prepareSelectedClip} =
    useUploadSession();
  const [uploadPreviewMode, setUploadPreviewMode] =
    useState<UploadPreviewMode>('manual');

  const defaultVideo = useMemo(() => {
    return createReadyVideoData(data.defaultVideo);
  }, [data.defaultVideo]);

  const video = useMemo(() => {
    return state?.video ?? defaultVideo;
  }, [defaultVideo, state]);

  useEffect(() => {
    setInputVideo(video);
  }, [video, setInputVideo]);

  useEffect(() => {
    setUploadPreviewMode('manual');
  }, [video]);

  useEffect(() => {
    return () => {
      void clearUploadSession();
    };
  }, [clearUploadSession]);

  const showSegmentMode = (uploadSession?.sourceDurationSec ?? 0) > 0;

  useEffect(() => {
    if (!showSegmentMode && uploadPreviewMode !== 'manual') {
      setUploadPreviewMode('manual');
    }
  }, [showSegmentMode, uploadPreviewMode]);

  const handleStartInteraction = useCallback(async () => {
    if (uploadSession?.status !== 'uploaded') {
      return;
    }

    const readyVideo = await prepareSelectedClip();
    if (readyVideo == null) {
      return;
    }

    navigate(location.pathname, {
      state: {
        video: readyVideo,
      },
    });

    window.setTimeout(() => {
      void clearUploadSession();
    }, 0);
  }, [
    clearUploadSession,
    location.pathname,
    navigate,
    prepareSelectedClip,
    uploadSession?.status,
  ]);

  return isPreviewVideo(video) ? (
    <DemoPageLayout>
      <StatsView />
      <UploadPreviewSidebar
        previewMode={uploadPreviewMode}
        showSegmentMode={showSegmentMode}
        onPreviewModeChange={setUploadPreviewMode}
        onStartInteraction={handleStartInteraction}
      />
      <UploadPreviewPlayer
        video={video}
        previewMode={uploadPreviewMode}
        showSegmentMode={showSegmentMode}
      />
    </DemoPageLayout>
  ) : (
    <DemoPageLayout>
      <StatsView />
      <Toolbar />
      <DemoVideoEditor video={video} />
    </DemoPageLayout>
  );
}
