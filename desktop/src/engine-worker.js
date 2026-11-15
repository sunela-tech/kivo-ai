// INKOS Desktop drawing engine, run in a Web Worker made from a Blob URL
// (pages opened from disk cannot load worker files).
// Messages in:  {id, type: 'init', font}
//               {id, type: 'load', model, index, buffer}      buffer is transferred
//               {id, type: 'generate', model, prompt, size, seed, temperature, topP}
// Messages out: {id, type: 'progress' | 'ready' | 'loaded' | 'result' | 'error', ...}
import { createEngine } from './engine-core.js';

const engine = createEngine((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = (e) => engine.handle(e.data);
