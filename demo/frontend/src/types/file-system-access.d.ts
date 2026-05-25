export type DirectoryPickerMode = 'read' | 'readwrite';

export type LocalFileSystemWritableFileStream = {
  write: (data: Blob | BufferSource | string) => Promise<void>;
  close: () => Promise<void>;
};

export type LocalFileSystemFileHandle = {
  kind: 'file';
  name: string;
  createWritable: () => Promise<LocalFileSystemWritableFileStream>;
};

export type LocalFileSystemDirectoryHandle = {
  kind: 'directory';
  name: string;
  getDirectoryHandle: (
    name: string,
    options?: {create?: boolean},
  ) => Promise<LocalFileSystemDirectoryHandle>;
  getFileHandle: (
    name: string,
    options?: {create?: boolean},
  ) => Promise<LocalFileSystemFileHandle>;
};

export type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: DirectoryPickerMode;
  }) => Promise<LocalFileSystemDirectoryHandle>;
};
