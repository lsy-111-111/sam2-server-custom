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
import {getBrowserSupportIssue} from '@/common/browser/BrowserCapabilities';
import LoadingStateScreen from '@/common/loading/LoadingStateScreen';
import DemoPage from '@/routes/DemoPage';
import {isFirefox} from 'react-device-detect';

export default function DemoPageWrapper() {
  const issue = getBrowserSupportIssue();

  if (issue != null) {
    return (
      <LoadingStateScreen
        title={issue.title}
        description={issue.description}
        linkProps={{to: '..', label: 'Back to homepage'}}>
        <div className="rounded-lg border border-white/15 bg-white/5 px-4 py-3 text-left text-sm text-[#A7B3BF]">
          <div>Reason: {issue.reason}</div>
          {isFirefox && (
            <div className="mt-2">
              Firefox Nightly may expose the missing APIs sooner than the stable
              channel, but Chrome or Edge usually work best for this demo.
            </div>
          )}
        </div>
      </LoadingStateScreen>
    );
  }

  return <DemoPage />;
}
