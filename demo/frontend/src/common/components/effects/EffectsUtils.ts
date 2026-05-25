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
import {canUseWorkerWebGL2} from '@/common/browser/BrowserCapabilities';
import {
  effectPresets as fullEffectPresets,
  type Effects,
  type EffectsCombo,
} from '@/common/components/video/effects/Effects';
import type {CarbonIconType} from '@carbon/icons-react';
import {
  AppleDash,
  Asterisk,
  Barcode,
  CenterCircle,
  ColorPalette,
  ColorSwitch,
  Development,
  Erase,
  FaceWink,
  Humidity,
  Image,
  Overlay,
  TextFont,
} from '@carbon/icons-react';

export type DemoEffect = {
  title: string;
  Icon: CarbonIconType;
  effectName: keyof Effects;
};

const WORKER_WEBGL2_SUPPORTED = canUseWorkerWebGL2();

const allBackgroundEffects: DemoEffect[] = [
  {title: 'Original', Icon: Image, effectName: 'Original'},
  {title: 'Erase', Icon: Erase, effectName: 'EraseBackground'},
  {
    title: 'Gradient',
    Icon: ColorPalette,
    effectName: 'Gradient',
  },
  {
    title: 'Pixelate',
    Icon: Development,
    effectName: 'Pixelate',
  },
  {title: 'Desaturate', Icon: ColorSwitch, effectName: 'Desaturate'},
  {title: 'Text', Icon: TextFont, effectName: 'BackgroundText'},
  {title: 'Blur', Icon: Humidity, effectName: 'BackgroundBlur'},
  {title: 'Outline', Icon: AppleDash, effectName: 'Sobel'},
];

const allHighlightEffects: DemoEffect[] = [
  {title: 'Original', Icon: Image, effectName: 'Cutout'},
  {title: 'Erase', Icon: Erase, effectName: 'EraseForeground'},
  {title: 'Gradient', Icon: ColorPalette, effectName: 'VibrantMask'},
  {title: 'Pixelate', Icon: Development, effectName: 'PixelateMask'},
  {
    title: 'Overlay',
    Icon: Overlay,
    effectName: 'Overlay',
  },
  {title: 'Emoji', Icon: FaceWink, effectName: 'Replace'},
  {title: 'Burst', Icon: Asterisk, effectName: 'Burst'},
  {title: 'Spotlight', Icon: CenterCircle, effectName: 'Scope'},
];

const allMoreEffects: DemoEffect[] = [
  {title: 'Noisy', Icon: Barcode, effectName: 'NoisyMask'},
];

const fallbackBackgroundEffects: DemoEffect[] = [
  {title: 'Original', Icon: Image, effectName: 'Original'},
  {title: 'Erase', Icon: Erase, effectName: 'EraseBackground'},
  {title: 'Desaturate', Icon: ColorSwitch, effectName: 'Desaturate'},
  {title: 'Text', Icon: TextFont, effectName: 'BackgroundText'},
];

const fallbackHighlightEffects: DemoEffect[] = [
  {
    title: 'Overlay',
    Icon: Overlay,
    effectName: 'Overlay',
  },
  {title: 'Erase', Icon: Erase, effectName: 'EraseForeground'},
];

const fallbackEffectPresets: EffectsCombo[] = [
  [
    {name: 'Original', variant: 0},
    {name: 'Overlay', variant: 0},
  ],
  [
    {name: 'Desaturate', variant: 0},
    {name: 'Overlay', variant: 1},
  ],
  [
    {name: 'BackgroundText', variant: 1},
    {name: 'Overlay', variant: 2},
  ],
  [
    {name: 'EraseBackground', variant: 0},
    {name: 'EraseForeground', variant: 0},
  ],
];

export const workerWebGL2Supported = WORKER_WEBGL2_SUPPORTED;

export const backgroundEffects = WORKER_WEBGL2_SUPPORTED
  ? allBackgroundEffects
  : fallbackBackgroundEffects;

export const highlightEffects = WORKER_WEBGL2_SUPPORTED
  ? allHighlightEffects
  : fallbackHighlightEffects;

export const moreEffects = WORKER_WEBGL2_SUPPORTED ? allMoreEffects : [];

export const effectPresets = WORKER_WEBGL2_SUPPORTED
  ? fullEffectPresets
  : fallbackEffectPresets;
