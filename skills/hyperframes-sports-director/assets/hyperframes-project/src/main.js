import { installSceneRuntime } from './scene-runtime.js';

if (typeof window !== 'undefined' && window.__HYPERFRAMES_COMPILED__) {
  installSceneRuntime(window, window.__HYPERFRAMES_COMPILED__);
}
