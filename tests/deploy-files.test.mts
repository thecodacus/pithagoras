import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const COMPOSE = ['docker-compose.yml', 'docker-compose.portainer.yml'];

/** The names under `environment:`, in a Compose file written the way these are: one `NAME: value` per line. */
const environmentOf = (file: string): string[] => {
  const lines = read(file).split('\n');
  const from = lines.findIndex((l) => /^ {4}environment:/.test(l));
  assert.ok(from >= 0, `${file} has an environment`);
  const names: string[] = [];
  for (const line of lines.slice(from + 1)) {
    if (/^\S/.test(line) || /^ {0,4}\S/.test(line)) break;
    const name = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line);
    if (name) names.push(name[1]);
  }
  return names;
};

/** Every `${NAME...}` a Compose file reads from the shell or .env. */
const readsOf = (file: string): string[] => [...new Set([...read(file).matchAll(/\$\{([A-Z][A-Z0-9_]*)[:}-]/g)].map((m) => m[1]))];

test('the Portainer stack passes the same environment as the Compose file', () => {
  assert.deepEqual([...environmentOf('docker-compose.portainer.yml')].sort(), [...environmentOf('docker-compose.yml')].sort());
});

test('the portal runs under an init in both Compose files, which collects the processes its jobs and shells leave behind', (t) => {
  const compose = spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status === 0;
  if (!compose) t.diagnostic('docker compose is not installed: only the files are read, Compose does not read them back');
  for (const file of COMPOSE) {
    assert.match(read(file), /^ {4}init: true$/m, `${file} gives the portal an init`);
    if (!compose) continue;
    // Interpolated, with the one variable the files require: Compose 2.38 cannot read a volume such as
    // `${PORTAL_TLS_DIR:-/dev/null}:/certs:ro` under --no-interpolate ("too many colons").
    const shown = JSON.parse(
      execFileSync('docker', ['compose', '-f', path.join(root, file), 'config', '--format', 'json'], {
        env: { ...process.env, WORKSPACES_DIR: '/workspaces' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString(),
    );
    assert.equal(Object.values<any>(shown.services)[0].init, true, `${file}: Compose reads it as the service's init`);
  }
});

test('the data folder PORTAL_DATA_DIR names is mounted by both Compose files, and without it the data is in a volume', () => {
  for (const file of COMPOSE) {
    assert.match(read(file), /- \$\{PORTAL_DATA_DIR:-[\w-]+\}:\/data$/m, `${file} mounts PORTAL_DATA_DIR at /data`);
  }
});

test('the upgrade guide warns a Portainer stack that sets PORTAL_DATA_DIR, which the first release ignored', () => {
  const guide = read('docs/guide/upgrading.md');
  const from = guide.indexOf('## Upgrading to 0.1.0 from an earlier build');
  assert.ok(from >= 0, 'the guide has a section for builds from before 0.1.0');
  const section = guide.slice(from);
  assert.match(section, /Portainer stack[\s\S]*PORTAL_DATA_DIR[\s\S]*<stack>_pithagoras-data/, 'the section for builds from before 0.1.0 names the stack, the variable and the old volume');
  // The old home of the data is what the warning tells people to copy from.
  assert.match(read('docker-compose.portainer.yml'), /\$\{PORTAL_DATA_DIR:-pithagoras-data\}:\/data/);
});

test('what the docs tell a deployment to set reaches the container: the clock, the upgrade backup, an open listener, the TLS files, the browser address', () => {
  for (const file of COMPOSE) {
    const names = environmentOf(file);
    for (const name of ['TZ', 'PORTAL_UPGRADE_BACKUP', 'ALLOW_OPEN', 'PORTAL_ALLOW_NO_PASSWORD', 'PORTAL_TLS_CERT', 'PORTAL_TLS_KEY', 'LLAMA_BASE_URL', 'LLAMA_DISK_CACHE_MODELS', 'OPENAI_API_KEY', 'BROWSER_BIND']) {
      assert.ok(names.includes(name), `${file} passes ${name}`);
    }
    assert.match(read(file), /\$\{PORTAL_TLS_DIR:-\/dev\/null\}:\/certs:ro/, `${file} mounts the certificates`);
    // An empty TZ would make the runtime name its clock "Etc/Unknown" on the heartbeat and routine pages.
    assert.match(read(file), /TZ: \$\{TZ:-UTC\}/, `${file} gives the clock a zone when none is set`);
  }
});

test('the command the deployment guide gives for .env gives the portal the folder that was typed, whatever characters it holds, and no password', () => {
  const command = /^printf ['"].*> \.env$/m.exec(read('docs/guide/deploying.md'))?.[0];
  assert.ok(command, 'the guide has the command');
  // A folder name with the symbols a path can hold. `%` and `\` are what printf reads as a conversion and an escape in its format;
  // `$` and ` #` are what Compose reads in a value without quotes as a variable and a comment.
  const folder = '/srv/my %d repos $HOME #x-50%off-%s-%b-\\n-${SHELL}';
  const edited = command.replace("'/path/to/repos'", () => `'${folder}'`);
  assert.notEqual(edited, command, 'the placeholder is in the command');

  const temp = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'pitha-env-'));
  try {
    // openssl is not what is under test, and is not on every machine.
    mkdirSync(path.join(temp, 'bin'));
    writeFileSync(path.join(temp, 'bin', 'openssl'), '#!/bin/sh\necho 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n');
    chmodSync(path.join(temp, 'bin', 'openssl'), 0o755);
    execFileSync('bash', ['-c', edited], { cwd: temp, env: { ...process.env, PATH: `${path.join(temp, 'bin')}:${process.env.PATH}` } });
    // The password is chosen in the browser: nothing to type here, and none written.
    assert.deepEqual(readFileSync(path.join(temp, '.env'), 'utf8').split('\n'), [
      `WORKSPACES_DIR='${folder}'`,
      'PORTAL_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '',
    ]);

    // What reaches the container is what Compose makes of the file, not the file. An install from before has its
    // password in this file, and the portal moves it into its database on the first start after the upgrade: it has to
    // reach the container as typed, or the sign-in would refuse the one that was typed.
    const password = 'Pa$$w0rd #x-50%off';
    writeFileSync(path.join(temp, '.env'), `${readFileSync(path.join(temp, '.env'), 'utf8')}PORTAL_PASSWORD='${password}'\n`);
    if (spawnSync('docker', ['compose', 'version'], { stdio: 'ignore' }).status !== 0) return;
    for (const file of COMPOSE) {
      const shown = JSON.parse(
        execFileSync('docker', ['compose', '-f', path.join(root, file), '--env-file', path.join(temp, '.env'), 'config', '--format', 'json'], {
          cwd: temp,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
          stdio: ['ignore', 'pipe', 'ignore'],
        }).toString(),
      );
      const environment = Object.values<any>(shown.services)[0].environment;
      // `config` writes its own output so that Compose could read it again: a `$` comes out as `$$`.
      assert.equal(environment.PORTAL_PASSWORD.replaceAll('$$', '$'), password, `${file} gives the container the password as typed`);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('no Compose file mounts a default workspace folder: it is asked for, and no install\'s path is a default', () => {
  for (const file of COMPOSE) {
    assert.match(read(file), /\$\{WORKSPACES_DIR:\?[^}]+\}:\/workspaces/, `${file} refuses to start without WORKSPACES_DIR`);
  }
  for (const file of [...COMPOSE, '.env.example', 'README.md']) assert.doesNotMatch(read(file), /\/root\/repos/, file);
  // Set in .env.example, it would be the default again for everybody who copies the file.
  assert.doesNotMatch(read('.env.example'), /^WORKSPACES_DIR=/m);
});

test('.env.example lists every variable a Compose file reads', () => {
  const example = read('.env.example');
  // Passed on only so that an install from before, whose .env still holds its password, has it moved into the
  // database once. A new install sets none: the password is chosen in the browser, and the example does not have it.
  const upgradeOnly = ['PORTAL_PASSWORD'];
  for (const name of new Set(COMPOSE.flatMap(readsOf))) {
    if (upgradeOnly.includes(name)) {
      assert.doesNotMatch(example, new RegExp(name), `${name} is not in .env.example`);
      continue;
    }
    assert.match(example, new RegExp(`^(# )?${name}=`, 'm'), `${name} is in .env.example`);
  }
});

const WORKFLOWS = ['test', 'docker', 'docs'].map((name) => `.github/workflows/${name}.yml`);

/** The jobs of a workflow written the way these are: `jobs:` and then each job at two spaces, without the comments. */
const jobsOf = (file: string): Record<string, string> => {
  const text = read(file);
  const body = text.slice(text.indexOf('\njobs:\n') + 6);
  const jobs: Record<string, string> = {};
  let name = '';
  for (const line of body.split('\n').filter((l) => !/^\s*#/.test(l))) {
    const head = /^ {2}([\w-]+):\s*$/.exec(line);
    if (head) { name = head[1]; jobs[name] = ''; }
    else if (name) jobs[name] += line + '\n';
  }
  return jobs;
};

test('no workflow installs with npm install: a lock that disagrees with a package.json stops the run', () => {
  for (const file of WORKFLOWS) assert.doesNotMatch(read(file), /npm install/, file);
});

test('the test jobs have a time limit, run what a change can break, and can be called before an image is published', () => {
  const text = read('.github/workflows/test.yml');
  assert.match(text, /^ {2}workflow_call:/m);
  const jobs = jobsOf('.github/workflows/test.yml');
  assert.deepEqual(Object.keys(jobs).sort(), ['browser', 'server', 'web']);
  for (const [name, body] of Object.entries(jobs)) assert.match(body, /timeout-minutes: \d+/, `${name} is bounded`);
  assert.match(jobs.server, /- run: npm test\n/, 'the server tests and the root unit tests, the i18n test among them');
  assert.match(jobs.web, /- run: npm run build -w core\/web\n/, 'the type check and the build of the web app');
  assert.match(jobs.browser, /- run: npx playwright test /, 'the browser tests');
  // The checkout's token is not left in .git/config for the code under test.
  assert.equal([...text.matchAll(/actions\/checkout@v\d+\n\s+with:\n\s+persist-credentials: false/g)].length, 3);
});

test('an image is built only after the tests passed, from the Dockerfile alone, and a newer push replaces an older build of main, not a release\'s', () => {
  const text = read('.github/workflows/docker.yml');
  const jobs = jobsOf('.github/workflows/docker.yml');
  assert.match(jobs.test, /uses: \.\/\.github\/workflows\/test\.yml/);
  assert.match(jobs.build, /needs: test/);
  // A release calls it with its tag; a tag does not start it.
  const triggers = text.slice(text.indexOf('\non:\n'), text.indexOf('\nenv:\n'));
  assert.match(triggers, /^ {2}workflow_call:\n {4}inputs:\n {6}tag:/m);
  assert.doesNotMatch(triggers, /tags:/);
  assert.match(text, /concurrency:\n\s+group: docker-\$\{\{ inputs\.tag \|\| github\.ref \}\}\n\s+cancel-in-progress: \$\{\{ !inputs\.tag \}\}/);
  // The runner has the token that publishes the image: no dependency's install script runs on it, and the checkout does not keep it.
  assert.doesNotMatch(jobs.build, /setup-node|npm /);
  assert.match(jobs.build, /actions\/checkout@v\d+\n\s+with:\n\s+persist-credentials: false/);
  // Actions that are not GitHub's own are pinned to a commit.
  const outside = [...jobs.build.matchAll(/uses: ([^\s@]+)@(\S+)/g)].filter((m) => !m[1].startsWith('actions/'));
  assert.ok(outside.length >= 4);
  for (const [, action, ref] of outside) assert.match(ref, /^[0-9a-f]{40}$/, `${action} is pinned`);
});

const RELEASE = '.github/workflows/publish-extension-api.yml';

/** The permissions a job asks for: each `name: level` under its `permissions:`. */
const permissionsOf = (job: string): Record<string, string> => {
  const lines = job.split('\n');
  const held: Record<string, string> = {};
  for (const line of lines.slice(lines.findIndex((l) => /^ {4}permissions:\s*$/.test(l)) + 1)) {
    const entry = /^ {6}([\w-]+): (\w+)\s*$/.exec(line);
    if (!entry) break;
    held[entry[1]] = entry[2];
  }
  return held;
};

/** The script of the step with `id: <id>`, written as `run: |` on the line after the id. */
const scriptOf = (file: string, id: string): string => {
  const lines = read(file).split('\n');
  const at = lines.findIndex((l) => l.trim() === `id: ${id}`);
  assert.ok(at >= 0 && lines[at + 1].trim() === 'run: |', `${file} has the step ${id}`);
  const indent = lines[at + 1].length - lines[at + 1].trimStart().length + 2;
  const script: string[] = [];
  for (const line of lines.slice(at + 2)) {
    if (line.trim() && line.length - line.trimStart().length < indent) break;
    script.push(line.slice(indent));
  }
  return script.join('\n');
};

test('a release is one workflow, the one npm\'s trusted publisher names, and each of its jobs holds only what it needs', () => {
  const text = read(RELEASE);
  const jobs = jobsOf(RELEASE);
  assert.deepEqual(Object.keys(jobs), ['gate', 'image', 'npm', 'github-release']);
  assert.deepEqual(permissionsOf(jobs.gate), { contents: 'write' });
  assert.deepEqual(permissionsOf(jobs.image), { contents: 'read', packages: 'write' });
  assert.deepEqual(permissionsOf(jobs.npm), { contents: 'read', 'id-token': 'write' });
  assert.deepEqual(permissionsOf(jobs['github-release']), { contents: 'write' });
  for (const name of ['image', 'npm', 'github-release']) assert.match(jobs[name], /if: needs\.gate\.outputs\.release == 'true'/, `${name} waits for the gate`);
  // The image is docker.yml's, which runs the tests first, and the package and the GitHub release come after it.
  assert.match(jobs.image, /uses: \.\/\.github\/workflows\/docker\.yml\n\s+with:\n\s+tag: \$\{\{ needs\.gate\.outputs\.tag \}\}/);
  assert.match(jobs.npm, /needs: \[gate, image\]/);
  assert.match(jobs['github-release'], /needs: \[gate, npm\]/);
  // npm matches a trusted publisher against the workflow a run started from: the publish is in this file, and in no other.
  assert.match(text, /^ {2}NPM_PUBLISH: \$\{\{ vars\.NPM_STAGE == 'true' && 'npm stage publish' \|\| 'npm publish' \}\} -w packages\/extension-api$/m);
  assert.match(jobs.npm, /\n\s+\$NPM_PUBLISH\n/);
  assert.doesNotMatch(jobs.npm, /npm ci/, 'no dependency is installed where the identity that can publish is');
  for (const file of ['test', 'docker', 'docs'].map((name) => `.github/workflows/${name}.yml`)) assert.doesNotMatch(read(file), /npm (stage )?publish/, file);
  // One release at a time, and none is cancelled half way.
  assert.match(text, /\nconcurrency:\n\s+group: release\n\s+cancel-in-progress: false\n/);
});

test('the release gate tags and releases a version that has no tag, releases nothing for one that has, and stops when the versions differ', () => {
  const script = scriptOf(RELEASE, 'tag');
  const temp = mkdtempSync(path.join(tmpdir(), 'release-gate-'));
  // Git as the runner has it: none of this machine's own settings (signing, hooks) apply.
  const isolated = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...isolated } }).trim();
  try {
    const origin = path.join(temp, 'origin.git');
    const work = path.join(temp, 'work');
    git(temp, 'init', '-q', '--bare', origin);
    git(temp, 'clone', '-q', origin, work);
    mkdirSync(path.join(work, 'packages/extension-api'), { recursive: true });
    const merge = (portal: string, api: string) => {
      writeFileSync(path.join(work, 'package.json'), JSON.stringify({ version: portal }));
      writeFileSync(path.join(work, 'packages/extension-api/package.json'), JSON.stringify({ version: api }));
      git(work, 'add', '-A');
      git(work, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', `${portal}`);
      git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
      return git(work, 'rev-parse', 'HEAD');
    };
    const tagged = (tag: string) => git(work, 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`).split('\t')[0];
    const gate = (env: Record<string, string>) => {
      const output = path.join(temp, 'output');
      writeFileSync(output, '');
      const run = spawnSync('bash', ['-eo', 'pipefail', '-c', script], { cwd: work, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: temp, ...isolated, GITHUB_OUTPUT: output, ...env } });
      const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => line.split('=')));
      return { status: run.status, said: run.stdout + run.stderr, outputs };
    };
    const pushed = (sha: string) => ({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_SHA: sha });
    const tagPushed = (tag: string, sha: string) => ({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: tag, GITHUB_SHA: sha });

    // A merge that leaves the version as it was, already tagged, releases nothing.
    const before = merge('0.2.0', '0.2.0');
    git(work, 'push', '-q', 'origin', `${before}:refs/tags/v0.2.0`);
    let run = gate(pushed(before));
    assert.equal(run.status, 0, run.said);
    assert.match(run.said, /v0\.2\.0 exists: nothing to release/);
    assert.deepEqual(run.outputs, { release: 'false' });

    // The merge that raises both versions is tagged, and released.
    const raised = merge('0.3.0', '0.3.0');
    run = gate(pushed(raised));
    assert.equal(run.status, 0, run.said);
    assert.deepEqual(run.outputs, { tag: 'v0.3.0', version: '0.3.0', release: 'true' });
    assert.equal(tagged('v0.3.0'), raised);
    // Run again from the gate, it finds its tag and releases nothing.
    assert.deepEqual(gate(pushed(raised)).outputs, { release: 'false' });

    // A tag pushed by hand is released when it is the version, and stops the run when it is not.
    assert.deepEqual(gate(tagPushed('v0.3.0', raised)).outputs, { tag: 'v0.3.0', version: '0.3.0', release: 'true' });
    run = gate(tagPushed('v0.3.1', raised));
    assert.equal(run.status, 1);
    assert.match(run.said, /the tag v0\.3\.1 is not v0\.3\.0/);
    // Run by hand on a branch, there is no tag to release.
    assert.equal(gate({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main', GITHUB_SHA: raised }).status, 1);

    // Versions that differ stop the run before anything is tagged.
    const apart = merge('0.4.0', '0.3.0');
    run = gate(pushed(apart));
    assert.equal(run.status, 1);
    assert.match(run.said, /packages\/extension-api\/package\.json says 0\.3\.0 and package\.json 0\.4\.0/);
    assert.equal(tagged('v0.4.0'), '');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('the docs are built with the whole history, and only the job that deploys holds the deployment token', () => {
  const text = read('.github/workflows/docs.yml');
  const jobs = jobsOf('.github/workflows/docs.yml');
  assert.match(jobs.build, /fetch-depth: 0/);
  assert.match(jobs.build, /persist-credentials: false/);
  assert.doesNotMatch(jobs.build, /id-token/);
  assert.match(jobs.deploy, /id-token: write/);
  // Nothing under the top-level channels folder is part of the docs build.
  assert.doesNotMatch(text, /channels\/\*\*/);
});

test('the docs site names its favicon under the base it is served from, whatever it is', async () => {
  const faviconFor = async (base: string | undefined) => {
    if (base === undefined) delete process.env.DOCS_BASE;
    else process.env.DOCS_BASE = base;
    // Read once at import, so each base is a module of its own.
    const config = (await import(`../docs/.vitepress/config.mts?base=${encodeURIComponent(String(base))}`)).default;
    return { base: config.base, href: config.head[0][1].href };
  };
  const had = process.env.DOCS_BASE;
  try {
    assert.deepEqual(await faviconFor(undefined), { base: '/pithagoras/', href: '/pithagoras/favicon.png' });
    assert.deepEqual(await faviconFor('/'), { base: '/', href: '/favicon.png' });
    assert.deepEqual(await faviconFor('/fork'), { base: '/fork/', href: '/fork/favicon.png' });
  } finally {
    if (had === undefined) delete process.env.DOCS_BASE;
    else process.env.DOCS_BASE = had;
  }
});

test('the docs are built under the path they are served from, and the links to them are written the way that path is spelled', () => {
  // GitHub Pages paths are case-sensitive: the upstream repository is pithagoras, and a fork has its own name.
  assert.match(jobsOf('.github/workflows/docs.yml').build, /- run: npm run docs:build\n\s+env:\n\s+DOCS_BASE: \/\$\{\{ github\.event\.repository\.name \}\}\//);
  for (const file of ['README.md', 'channels/README.md']) {
    const links = [...read(file).matchAll(/thecodacus\.github\.io\/([^/\s)"]+)\//g)].map((m) => m[1]);
    assert.ok(links.length, `${file} links to the docs`);
    for (const name of links) assert.equal(name, 'pithagoras', `${file} links to the docs under the repository's own spelling`);
  }
});

test('every ctx.ask in the channel guide passes the session and the sender, and the guide says the sender\'s id is a string', () => {
  // The portal throws for an ask without a session, and turns a message with no sender away once somebody is primary.
  const guide = read('docs/channels/writing-a-channel.md').split('\n');
  const calls = guide.flatMap((line, at) => (/ctx\.ask\(.*\{$/.test(line) ? [guide.slice(at, at + 6).join('\n')] : []));
  assert.ok(calls.length >= 5, 'the guide has its examples');
  for (const call of calls) {
    assert.match(call, /session:/, call);
    assert.match(call, /from:/, call);
  }
  assert.match(guide.join('\n'), /`id` has to be a string/);
});

const dockerfile = () => read('Dockerfile').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('the image takes what the lock says, the pi on PATH is the locked one, and nothing on the data volume can stand in for node', () => {
  const text = dockerfile();
  assert.doesNotMatch(text, /npm install/, 'npm ci, which stops where the lock and a package.json disagree');
  assert.match(text, /^RUN npm ci$/m, 'the build stage');
  assert.match(text, /RUN npm ci --omit=dev -w core\/server --ignore-scripts \\\n\s+&& npm cache clean --force/, 'the runtime stage, with its download cache gone from the layer');
  assert.doesNotMatch(text, /@latest/, 'no release of pi nobody looked at');
  assert.match(text, /ln -s \/app\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/cli\.js \/usr\/local\/bin\/pi/);
  // /data/bin comes after the system's folders, and the portal starts from the node of the image by its full path.
  assert.match(text, /^ENV PATH=\$PATH:\/data\/bin$/m);
  assert.match(text, /^CMD \["\/usr\/local\/bin\/node", "core\/server\/dist\/index\.js"\]$/m);
});

test('the build context leaves out local data and what the image builds itself, and nothing the Dockerfile copies', () => {
  const ignored = read('.dockerignore').split('\n').filter((l) => l && !l.startsWith('#'));
  for (const pattern of ['**/node_modules', '**/data', '.local-data', '.git', '.env*', 'voice-runtime', 'core/server/dist', 'core/web/dist', 'core/web/public/voice-assets']) {
    assert.ok(ignored.includes(pattern), `${pattern} is left out of the context`);
  }
  const matches = (pattern: string, source: string) => {
    const re = new RegExp('^' + pattern.replace(/^\*\*\//, '(?:.*/)?').replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*') + '(?:/.*)?$');
    return re.test(source);
  };
  const copied = [...dockerfile().matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((m) => m[1].split(/\s+/));
  assert.ok(copied.includes('THIRD_PARTY_NOTICES.md') && copied.includes('package-lock.json') && copied.includes('core'));
  for (const source of copied) for (const pattern of ignored) assert.ok(!matches(pattern, source), `${source} is copied but ${pattern} leaves it out`);
});

// The server moved from server/ to core/server (#198). A service, the restart after an update, or a container's
// `node server/dist/reset-password.js` that still names the old place starts the same file from the new one.
test('a start file in the old server/dist runs the same file in core/server/dist, with its arguments, and the image has them', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pithagoras-old-entries-'));
  try {
    mkdirSync(path.join(dir, 'scripts'));
    writeFileSync(path.join(dir, 'scripts', 'old-entries.mjs'), read('scripts/old-entries.mjs'));
    mkdirSync(path.join(dir, 'core', 'server', 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'core', 'server', 'package.json'), read('core/server/package.json'));
    const entries = ['index.js', 'reset-password.js', 'sso-only-off.js'];
    for (const entry of entries) writeFileSync(path.join(dir, 'core', 'server', 'dist', entry), `console.log("core/server/dist/${entry}", process.argv.slice(2).join(" "));\n`);
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'old-entries.mjs')], { stdio: 'ignore' });
    for (const entry of entries) {
      assert.equal(execFileSync(process.execPath, [path.join(dir, 'server', 'dist', entry), '--yes'], { encoding: 'utf8' }), `core/server/dist/${entry} --yes\n`, entry);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(read('package.json'), /"build": "[^"]*&& node scripts\/old-entries\.mjs"/, 'the build writes them');
  assert.match(dockerfile(), /^COPY --from=build \/app\/server\/dist server\/dist$/m, 'the image has them');
});

test('the README of the channels folder says what the folder is and points at the guide, with no second copy of the contract to go stale', () => {
  const readme = read('channels/README.md');
  assert.ok(readme.includes('/channels/writing-a-channel)'));
  // What it once said, wrongly: one session for every channel, and keys prefixed with the channel's id.
  assert.doesNotMatch(readme, /same agent session|prefixed with the channel id|ctx\.ask\(/);
  assert.ok(readme.split('\n').length < 20, 'a pointer, not a guide');
  // The guide has the contract, with the sender every message has to carry.
  assert.match(read('docs/channels/writing-a-channel.md'), /`from: \{ id, name \}` on `ctx\.ask`/);
});
