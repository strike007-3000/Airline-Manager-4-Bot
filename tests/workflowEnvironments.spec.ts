import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Jobs reading secrets.* (other than GITHUB_TOKEN) must declare an environment,
// so secrets are only released to jobs running from branches the environment allows.
// shortcut: line-based parse assumes 2-space-indented job keys; swap for a YAML parser if workflows get fancier.
const dir = path.join(__dirname, '..', '.github', 'workflows');

for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
  test(`${file}: jobs using secrets declare an environment`, () => {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
    const jobs: Record<string, string[]> = {};
    let inJobs = false;
    let current = '';
    for (const line of lines) {
      if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
      if (inJobs && /^\S/.test(line)) inJobs = false;
      const m = inJobs && line.match(/^ {2}([\w-]+):\s*$/);
      if (m) { current = m[1]; jobs[current] = []; }
      else if (inJobs && current) jobs[current].push(line);
    }
    for (const [name, body] of Object.entries(jobs)) {
      const usesSecret = body.some((l) => /secrets\.(?!GITHUB_TOKEN\b)\w+/.test(l));
      if (usesSecret) {
        expect(body.some((l) => /^ {4}environment:/.test(l)), `${file} job "${name}" reads secrets without environment`).toBe(true);
      }
    }
  });
}
