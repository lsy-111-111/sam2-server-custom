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
import {getErrorSummary} from '@/common/error/ErrorUtils';
import LoadingStateScreen from '@/common/loading/LoadingStateScreen';
import useSettingsContext from '@/settings/useSettingsContext';
import {FallbackProps} from 'react-error-boundary';

export default function DemoErrorFallback({error}: FallbackProps) {
  const {settings} = useSettingsContext();
  const summary = getErrorSummary(error);

  return (
    <LoadingStateScreen
      title="Well, this is embarrassing..."
      description="The demo hit an unexpected error before the page could finish loading."
      linkProps={{to: '..', label: 'Back to homepage'}}>
      <div className="rounded-lg border border-white/15 bg-white/5 px-4 py-3 text-left text-sm text-[#A7B3BF]">
        <div>Reason: {summary}</div>
        <div className="mt-2 break-all">
          Video API Endpoint:{' '}
          {settings.videoAPIEndpoint || '(same origin / proxied through frontend)'}
        </div>
        <div className="mt-1 break-all">
          Inference API Endpoint:{' '}
          {settings.inferenceAPIEndpoint ||
            '(same origin / proxied through frontend)'}
        </div>
      </div>
    </LoadingStateScreen>
  );
}
