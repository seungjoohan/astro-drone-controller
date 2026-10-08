import { defineConfig } from 'vite';
import { localPatrolPreview } from './scripts/patrol-preview-server.mjs';

export default defineConfig({ plugins: [localPatrolPreview()] });
