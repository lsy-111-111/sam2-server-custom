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
import PrimaryCTAButton from '@/common/components/button/PrimaryCTAButton';
import useVideo from '@/common/components/video/editor/useVideo';
import useReportError from '@/common/error/useReportError';
import {annotationExportSnapshotAtom, trimRangeAtom} from '@/demo/atoms';
import {ChevronRight} from '@carbon/icons-react';
import {useAtomValue, useSetAtom} from 'jotai';
import {useState} from 'react';

type Props = {
  onSessionClose: () => void;
};

export default function CloseSessionButton({onSessionClose}: Props) {
  const video = useVideo();
  const reportError = useReportError();
  const setAnnotationExportSnapshot = useSetAtom(annotationExportSnapshotAtom);
  const trimRange = useAtomValue(trimRangeAtom);
  const [isClosing, setIsClosing] = useState(false);

  async function handleCloseSession() {
    if (video == null || isClosing) {
      return;
    }

    try {
      setIsClosing(true);
      const annotationSnapshot = await video.exportAnnotations(1, true, trimRange);
      if (annotationSnapshot == null) {
        throw new Error(
          'Could not capture annotation data before closing the session.',
        );
      }
      setAnnotationExportSnapshot(annotationSnapshot);
      await video.closeSession();
      onSessionClose();
    } catch (error) {
      reportError(error);
    } finally {
      setIsClosing(false);
    }
  }

  return (
    <PrimaryCTAButton
      onClick={handleCloseSession}
      disabled={video == null || isClosing}
      endIcon={<ChevronRight />}>
      {isClosing ? 'Preparing export...' : 'Good to go'}
    </PrimaryCTAButton>
  );
}
