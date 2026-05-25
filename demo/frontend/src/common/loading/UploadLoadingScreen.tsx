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
import ChangeVideoModal from '@/common/components/gallery/ChangeVideoModal';
import type {VideoGalleryTriggerProps} from '@/common/components/gallery/DemoVideoGalleryModal';
import LoadingStateScreen from '@/common/loading/LoadingStateScreen';
import {uploadErrorAtom, uploadingStateAtom} from '@/demo/atoms';
import {
  MAX_UPLOAD_FILE_SIZE,
  MAX_UPLOAD_VIDEO_DURATION_SECONDS,
} from '@/demo/DemoConfig';
import {ImageCopy} from '@carbon/icons-react';
import {useAtomValue} from 'jotai';
import OptionButton from '../components/options/OptionButton';

export default function UploadLoadingScreen() {
  const uploadingState = useAtomValue(uploadingStateAtom);
  const uploadError = useAtomValue(uploadErrorAtom);

  if (uploadingState === 'error') {
    return (
      <LoadingStateScreen
        title="Uh oh, we cannot process this clip"
        description={`Please upload another video. Max file size is ${MAX_UPLOAD_FILE_SIZE}, and the selected clip limit is ${MAX_UPLOAD_VIDEO_DURATION_SECONDS}s.`}>
        {uploadError != null && (
          <div className="mx-auto mb-6 max-w-[520px] rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-left text-sm text-gray-300">
            <div className="font-medium text-white">Reason</div>
            <div className="mt-1 break-words">{uploadError}</div>
          </div>
        )}
        <div className="max-w-[250px] w-full mx-auto">
          <ChangeVideoModal
            videoGalleryModalTrigger={UploadLoadingScreenChangeVideoTrigger}
          />
        </div>
      </LoadingStateScreen>
    );
  }

  return (
    <LoadingStateScreen
      title="Uploading video..."
      description="Sit tight while we upload your video and prepare the selected clip for SAM 2."
    />
  );
}

function UploadLoadingScreenChangeVideoTrigger({
  onClick,
}: VideoGalleryTriggerProps) {
  return (
    <OptionButton
      variant="gradient"
      title="Change video"
      Icon={ImageCopy}
      onClick={onClick}
    />
  );
}
