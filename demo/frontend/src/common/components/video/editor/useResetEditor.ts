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
import {OBJECT_TOOLBAR_INDEX} from '@/common/components/toolbar/ToolbarConfig';
import useToolbarTabs from '@/common/components/toolbar/useToolbarTabs';
import useVideo from '@/common/components/video/editor/useVideo';
import {
  activeTrackletObjectIdAtom,
  DEFAULT_TRIM_RANGE,
  annotationExportSnapshotAtom,
  frameIndexAtom,
  isPlayingAtom,
  isStreamingAtom,
  sessionAtom,
  streamingStateAtom,
  trackletObjectNamesAtom,
  trackletObjectsAtom,
  trimRangeAtom,
} from '@/demo/atoms';
import {DEFAULT_EFFECT_LAYERS} from '@/demo/DemoConfig';
import {useSetAtom} from 'jotai';
import {useCallback} from 'react';

type State = {
  resetEditor: () => void;
  resetEffects: () => void;
  resetSession: () => void;
};

export default function useResetEditor(): State {
  const video = useVideo();

  const setSession = useSetAtom(sessionAtom);
  const setActiveTrackletObjectId = useSetAtom(activeTrackletObjectIdAtom);
  const setTrackletObjects = useSetAtom(trackletObjectsAtom);
  const setTrackletObjectNames = useSetAtom(trackletObjectNamesAtom);
  const setAnnotationExportSnapshot = useSetAtom(annotationExportSnapshotAtom);
  const setFrameIndex = useSetAtom(frameIndexAtom);
  const setTrimRange = useSetAtom(trimRangeAtom);
  const setStreamingState = useSetAtom(streamingStateAtom);
  const setIsPlaying = useSetAtom(isPlayingAtom);
  const setIsStreaming = useSetAtom(isStreamingAtom);
  const [, setDemoTabIndex] = useToolbarTabs();

  const resetEffects = useCallback(() => {
    video?.setEffect(DEFAULT_EFFECT_LAYERS.background, 0, {variant: 0});
    video?.setEffect(DEFAULT_EFFECT_LAYERS.highlight, 1, {variant: 0});
  }, [video]);

  const resetEditor = useCallback(() => {
    setFrameIndex(0);
    setTrimRange(DEFAULT_TRIM_RANGE);
    setSession(null);
    setActiveTrackletObjectId(0);
    setTrackletObjects([]);
    setTrackletObjectNames({});
    setAnnotationExportSnapshot(null);
    setStreamingState('none');
    setIsPlaying(false);
    setIsStreaming(false);
    resetEffects();
    setDemoTabIndex(OBJECT_TOOLBAR_INDEX);
  }, [
    setFrameIndex,
    setTrimRange,
    setSession,
    setActiveTrackletObjectId,
    setTrackletObjects,
    setTrackletObjectNames,
    setAnnotationExportSnapshot,
    setStreamingState,
    setIsPlaying,
    setIsStreaming,
    resetEffects,
    setDemoTabIndex,
  ]);

  const resetSession = useCallback(() => {
    setSession(prev => {
      if (prev === null) {
        return prev;
      }
      return {...prev, ranPropagation: false};
    });
    setAnnotationExportSnapshot(null);
    setTrackletObjectNames({});
    setActiveTrackletObjectId(null);
    resetEffects();
  }, [
    setSession,
    setAnnotationExportSnapshot,
    setTrackletObjectNames,
    setActiveTrackletObjectId,
    resetEffects,
  ]);

  return {resetEditor, resetEffects, resetSession};
}
