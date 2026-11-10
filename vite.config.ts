import { cpSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Озвучка грузится по путям из манифеста, мимо бандлера, поэтому её копируем сами.
// В сборку попадает только то, что игра проигрывает: дорожка диктовки и служебные реплики.
function copyVoiceover(): Plugin {
  let root = '';
  let outDir = '';
  return {
    name: 'copy-voiceover',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const rounds = join(root, 'voiceover', 'rounds');
      for (const round of readdirSync(rounds)) {
        const from = join(rounds, round);
        const to = join(outDir, 'voiceover', 'rounds', round);
        cpSync(join(from, 'dictation.mp3'), join(to, 'dictation.mp3'));
        cpSync(join(from, 'lines'), join(to, 'lines'), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  base: './',
  server: { watch: { ignored: ['**/voiceover/.state/**'] } },
  plugins: [copyVoiceover()],
});
