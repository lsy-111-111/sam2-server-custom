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
import DefaultVideoGalleryModalTrigger from '@/common/components/gallery/DefaultVideoGalleryModalTrigger';
import ServerVideoBrowser from '@/common/components/gallery/ServerVideoBrowser';
import useUploadSession from '@/common/components/upload/useUploadSession';
import {
  frameIndexAtom,
  sessionAtom,
  trackletObjectNamesAtom,
  uploadErrorAtom,
  uploadingStateAtom,
  VideoData,
} from '@/demo/atoms';
import {spacing} from '@/theme/tokens.stylex';
import {Close} from '@carbon/icons-react';
import stylex from '@stylexjs/stylex';
import {useSetAtom} from 'jotai';
import {ComponentType, useCallback, useRef, useState} from 'react';
import {Modal} from 'react-daisyui';
import DemoVideoGallery from './DemoVideoGallery';

const styles = stylex.create({
  container: {
    position: 'relative',
    minWidth: '85vw',
    minHeight: '85vh',
    overflow: 'hidden',
    color: '#fff',
    boxShadow: '0 0 100px 50px #000',
    borderRadius: 16,
    border: '2px solid transparent',
    background:
      'linear-gradient(#1A1C1F, #1A1C1F) padding-box, linear-gradient(to right bottom, #FB73A5,#595FEF,#94EAE2,#FCCB6B) border-box',
  },
  closeButton: {
    position: 'absolute',
    top: 0,
    right: 0,
    padding: spacing[3],
    zIndex: 10,
    cursor: 'pointer',
    ':hover': {
      opacity: 0.7,
    },
  },
  galleryContainer: {
    position: 'absolute',
    top: spacing[4],
    left: 0,
    right: 0,
    bottom: 0,
    overflowY: 'auto',
  },
});

export type VideoGalleryTriggerProps = {
  onClick: () => void;
};

type Props = {
  trigger?: ComponentType<VideoGalleryTriggerProps>;
  showUploadInGallery?: boolean;
  onOpen?: () => void;
  onSelect?: (video: VideoData, isUpload?: boolean) => void;
  onUploadVideoError?: (error: Error) => void;
};

export default function DemoVideoGalleryModal({
  trigger: VideoGalleryModalTrigger = DefaultVideoGalleryModalTrigger,
  showUploadInGallery = false,
  onOpen,
  onSelect,
  onUploadVideoError,
}: Props) {
  const modalRef = useRef<HTMLDialogElement | null>(null);
  const [view, setView] = useState<'gallery' | 'serverBrowser'>('gallery');

  const {clearUploadSession} = useUploadSession();
  const setFrameIndex = useSetAtom(frameIndexAtom);
  const setUploadingState = useSetAtom(uploadingStateAtom);
  const setUploadError = useSetAtom(uploadErrorAtom);
  const setSession = useSetAtom(sessionAtom);
  const setTrackletObjectNames = useSetAtom(trackletObjectNamesAtom);

  function openModal() {
    const modal = modalRef.current;
    if (modal != null) {
      setView('gallery');
      modal.style.display = 'grid';
      modal.showModal();
    }
  }

  function closeModal() {
    const modal = modalRef.current;
    if (modal != null) {
      setView('gallery');
      modal.close();
      modal.style.display = 'none';
    }
  }

  const handleSelect = useCallback(
    async (video: VideoData, isUpload?: boolean) => {
      closeModal();
      setFrameIndex(0);
      setSession(null);
      setTrackletObjectNames({});

      if (isUpload) {
        setUploadError(null);
      } else {
        await clearUploadSession();
      }

      onSelect?.(video, isUpload);
    },
    [
      clearUploadSession,
      onSelect,
      setFrameIndex,
      setSession,
      setTrackletObjectNames,
      setUploadError,
    ],
  );

  function handleUploadVideoStart() {
    setUploadError(null);
    setUploadingState('uploading');
    closeModal();
  }

  function handleOpenVideoGalleryModal() {
    onOpen?.();
    openModal();
  }

  return (
    <>
      <VideoGalleryModalTrigger onClick={handleOpenVideoGalleryModal} />
      <Modal ref={modalRef} {...stylex.props(styles.container)}>
        <div onClick={closeModal} {...stylex.props(styles.closeButton)}>
          <Close size={28} />
        </div>
        <Modal.Body>
          <div {...stylex.props(styles.galleryContainer)}>
            {view === 'gallery' ? (
              <DemoVideoGallery
                showUploadInGallery={showUploadInGallery}
                onSelect={video => void handleSelect(video)}
                onSelectServer={() => setView('serverBrowser')}
                onUpload={video => void handleSelect(video, true)}
                onUploadStart={handleUploadVideoStart}
                onUploadError={onUploadVideoError}
              />
            ) : (
              <ServerVideoBrowser
                onBack={() => setView('gallery')}
                onImport={video => void handleSelect(video, true)}
              />
            )}
          </div>
        </Modal.Body>
      </Modal>
    </>
  );
}
