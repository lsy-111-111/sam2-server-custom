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
import react from '@vitejs/plugin-react';
import jotaiDebugLabel from 'jotai/babel/plugin-debug-label';
import jotaiReactRefresh from 'jotai/babel/plugin-react-refresh';
import path from 'path';
import {defineConfig} from 'vite';
import babel from 'vite-plugin-babel';
import relay from 'vite-plugin-relay';
import {stylexPlugin} from 'vite-plugin-stylex-dev';

const backendProxyTarget =
  process.env.VITE_BACKEND_PROXY_TARGET ?? 'http://127.0.0.1:7263';
const frontendHost = process.env.VITE_HOST ?? '127.0.0.1';
const frontendPort = Number(process.env.VITE_PORT ?? 7262);

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    react({
      babel: {
        plugins: [jotaiDebugLabel, jotaiReactRefresh],
      },
    }),
    stylexPlugin(),
    relay,
    babel(),
  ],
  server: {
    host: frontendHost,
    port: frontendPort,
    strictPort: true,
    proxy: {
      '/graphql': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/api/uploads': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/api/server-files': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/api/annotations/export': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/api/videos': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/gallery': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/posters': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/uploads': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/propagate_in_video': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      '/healthy': {
        target: backendProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
  worker: {
    plugins: () => [relay],
  },
});
