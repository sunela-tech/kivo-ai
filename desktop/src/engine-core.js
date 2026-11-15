// The engine itself, usable in a Web Worker or, as a fallback, in the page.
import { describe, normalizePrompt } from '../../cloud/public/engine/lang.js';
import { generate, loadModel } from '../../cloud/public/engine/model.js';
import { encodePNG } from '../../cloud/public/engine/png.js';
import { render, setFont, usage } from '../../cloud/public/engine/render.js';

export function createEngine(post) {
  const models = {};

  async function run(msg) {
    const m = models[msg.model];
    if (!m) throw new Error('model not loaded');
    const t0 = performance.now();
    const prompt = normalizePrompt(msg.prompt, m.cfg.max_prompt);
    const color = m.cfg.vocab > 249;
    const res = generate(m, prompt, {
      seed: msg.seed, temperature: msg.temperature, topP: msg.topP,
      onToken: (step, max) => {
        if (step % 8 === 0) post({ id: msg.id, type: 'progress', stage: 'writing the drawing program', fraction: Math.min(0.9, step / max), detail: `${step} tokens` });
      },
    });
    post({ id: msg.id, type: 'progress', stage: 'rasterising', fraction: 0.93, detail: `${res.tokens.length} tokens` });
    const pic = render(res.ops, prompt, msg.size, msg.seed, color);
    const png = await encodePNG(pic.pixels, msg.size, color);
    const meta = {
      model: msg.model, model_name: m.info.name, prompt, size: msg.size, seed: msg.seed, temperature: msg.temperature,
      tokens: res.tokens.length, complete: res.complete, program: describe(res.ops),
      seconds: Math.round(performance.now() - t0) / 1000, colors: color ? usage(pic.pixels) : null,
      ink: usage(pic.pixels), weights: m.info.training,
    };
    post({ id: msg.id, type: 'result', png, meta }, [png.buffer]);
  }

  return {
    async handle(msg) {
      try {
        if (msg.type === 'init') { setFont(msg.font); post({ id: msg.id, type: 'ready' }); }
        else if (msg.type === 'load') {
          models[msg.model] = loadModel(msg.index, msg.buffer);
          post({ id: msg.id, type: 'loaded' });
        } else if (msg.type === 'generate') await run(msg);
      } catch (err) {
        post({ id: msg.id, type: 'error', error: String((err && err.message) || err) });
      }
    },
  };
}
