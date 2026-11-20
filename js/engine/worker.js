// Web Worker wrapper: keeps the engine's thinking off the UI thread.
import { Engine } from './engine.js';

const engine = new Engine();
self.onmessage = (e) => {
  const { id, moves, level } = e.data || {};
  let res;
  try {
    res = engine.think(Array.isArray(moves) ? moves : [], level);
  } catch (err) {
    res = { uci: null, error: String(err?.message || err) };
  }
  self.postMessage({ id, ...res });
};
