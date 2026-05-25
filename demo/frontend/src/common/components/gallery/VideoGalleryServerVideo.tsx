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
import {CSSProperties} from 'react';

type Props = {
  style: CSSProperties;
  onClick: () => void;
};

export default function VideoGalleryServerVideo({style, onClick}: Props) {
  return (
    <button
      type="button"
      className="cursor-pointer overflow-hidden rounded-none bg-gradient-to-br from-[#0F172A] via-[#1D4ED8] to-[#0891B2] text-left"
      style={style}
      onClick={onClick}>
      <div className="flex h-full w-full flex-col justify-center px-8 text-white">
        <div className="text-sm uppercase tracking-[0.24em] text-white/70">
          Server
        </div>
        <div className="mt-3 text-2xl font-medium leading-tight md:text-3xl">
          Browse folders
        </div>
        <div className="mt-3 max-w-xs text-sm leading-6 text-white/80 md:text-base">
          Import a video directly from the server filesystem into preview mode.
        </div>
      </div>
    </button>
  );
}
