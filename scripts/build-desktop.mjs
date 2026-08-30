// Desktop frontend build. A separate script rather than an inline env var in
// the npm script: `VAR=1 vite build` is not portable to Windows shells, and
// the desktop build has to be reproducible on the machine that ships it.
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['vite', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, VITE_DESKTOP: '1' },
});
process.exit(result.status ?? 1);
