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
import {hexToRgb} from '@/common/components/video/editor/VideoEditorUtils';
import {Tracklet} from '@/common/tracker/Tracker';
import {CanvasForm} from 'pts';
import {AbstractEffect, EffectFrameContext} from './Effect';
import {createMaskCanvas, EffectLayer} from './EffectUtils';

export default class Overlay2DEffect extends AbstractEffect {
  constructor() {
    super(8);
  }

  apply(
    form: CanvasForm,
    context: EffectFrameContext,
    _tracklets: Tracklet[],
  ): void {
    const opacity = [0.5, 0.75, 0.35, 0.95][this.variant % 4];

    context.masks.forEach((mask, index) => {
      const effect = new EffectLayer(context);
      const color = hexToRgb(context.maskColors[index]);
      effect.image(createMaskCanvas(mask.bitmap));
      effect.composite('source-in');
      effect.fill(`rgba(${color.r}, ${color.g}, ${color.b}, ${opacity})`);
      form.image([0, 0], effect.canvas);
    });
  }
}
