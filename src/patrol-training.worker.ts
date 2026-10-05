import { createCheckpoint } from './patrol-learning-checkpoint';
import { runSearch } from './patrol-search';
import type { LearningRequest, LearningResponse } from './patrol-learning-types';

let active = false;
let paused = false;
let cancelled = false;

function respond(message: LearningResponse): void {
  self.postMessage(message);
}

self.addEventListener('message', (event: MessageEvent<LearningRequest>) => {
  const request = event.data;
  if (!request || typeof request !== 'object') return;
  if (request.type === 'pause') paused = true;
  if (request.type === 'resume') paused = false;
  if (request.type === 'cancel') { cancelled = true; paused = false; }
  if (request.type !== 'start') return;
  if (active) { respond({ type: 'error', message: 'A search is already running.' }); return; }
  active = true;
  paused = false;
  cancelled = false;
  void runSearch(request.settings, progress => {
    respond({ type: 'progress', progress });
    if (progress.status === 'paused') respond({ type: 'checkpoint', checkpoint: createCheckpoint(request.settings, progress) });
  }, { isCancelled: () => cancelled, isPaused: () => paused, yieldControl: () => new Promise(resolve => setTimeout(resolve, paused ? 30 : 0)) })
    .then(progress => respond({ type: 'checkpoint', checkpoint: createCheckpoint(request.settings, progress) }))
    .catch(error => respond({ type: 'error', message: error instanceof Error ? error.message : 'Training failed. The visible mission is unchanged.' }))
    .finally(() => { active = false; });
});
