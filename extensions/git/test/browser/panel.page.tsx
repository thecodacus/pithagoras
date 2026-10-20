// Development-only fixture: the Git panel on a repository kept in the page, without a server. The panel is the Git
// extension's (extensions/git), loaded as the app loads it, and drawn with its head as the chat draws them.
// Open /tests/extension.html?page=git/panel to see it, with any of these after it (&, not ?): ?gh=off for a machine without gh, ?repo=none for a folder in no repository,
// ?ghslow=1 for a GitHub that takes seconds to answer, ?rename=1 for a renamed file with more changes in the
// tree, ?conflict=1 for a merge stopped on a conflict, ?op=am for patches stopped half way, ?prefix=src for a
// chat whose folder is src/ in the repository, ?comparefail=1 for a comparison git refuses, ?logfail=1 for a
// history that fails the first time it is asked, ?many=1 for a history of 250 commits (answered slowly, a page of
// 100 at a time), ?bigdiff=1 for diffs of 6,500 rows, ?prtruncated=1 for a pull request diff that stops in its last
// file, ?fork=1 for a pull request from a fork's `main` while `main` is checked out, ?pullsfail=1 and ?currentfail=1
// for GitHub failing the first time it is asked for the list and for this branch's pull request, ?prdifffail=1 for
// a pull request whose diff cannot be had, ?prfiles=1 for one that also renamed a file and deleted another, ?unmerged=1 for a branch that is not merged and has to be deleted
// anyway, ?nested=1 for a folder that also holds a clone of its own (tools/lib, with a repository of its own to pick; with
// ?repo=none it is the only one), ?branch=<name> for another branch checked out. window.stateFails = true makes reading the repository
// fail, as a portal that cannot be reached would. window.moveHead() moves HEAD, as a commit in the shell would.
// What the panel asked for is in window.gitCalls; window.agentWrote() changes a file the way the agent would.
import { useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../../core/web/src/styles';
import type { PortalEvent } from '../../../../core/web/src/api';
import { ConfirmHost } from '../../../../core/web/src/components/ConfirmDialog';
import { publishChat } from '../../../../core/web/src/extensions/chat-feed';
import { startExtensions } from '../../../../core/web/src/extensions/loader';
import { register, useSlot } from '../../../../core/web/src/extensions/slots';
import { channelFor } from '../../../../core/web/src/extensions/channel';
import { panelsFor } from '../../../../core/web/src/extensions/panels';

startExtensions();
// A panel by the name Files goes by, for Git to offer to open a file in: what it is opened with is written below.
register('test-files', 'chat.panel', { id: 'files', name: 'files', title: 'Files', component: () => null });
/** Where the Git extension's routes are, for the chat "s". */
const ROUTES = '/api/x/pithagoras-git/chats/s';

const params = new URLSearchParams(location.search);
const now = Math.floor(Date.now() / 1000);
const calls: { method: string; url: string; body?: any }[] = [];
(window as any).gitCalls = calls;

type File = { path: string; from?: string; x: string; y: string; kind: string; staged?: any; unstaged?: any };
const repo = {
  branch: params.get('branch') ?? (params.get('fork') ? 'main' : 'feature/login'),
  head: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
  upstream: 'origin/feature/login' as string | null,
  ahead: 2,
  behind: 0,
  stashes: 1,
  operation: null as string | null,
  files: [
    { path: 'src/auth/login.ts', x: 'M', y: '.', kind: 'changed', staged: { added: 12, removed: 3, binary: false } },
    { path: 'src/auth/session.ts', x: '.', y: 'M', kind: 'changed', unstaged: { added: 4, removed: 4, binary: false } },
    { path: 'README.md', x: '.', y: 'M', kind: 'changed', unstaged: { added: 1, removed: 0, binary: false } },
    { path: 'docs/login flow.md', x: '?', y: '?', kind: 'untracked' },
  ] as File[],
};
if (params.get('rename')) repo.files.push({ path: 'src/auth/token.ts', from: 'src/auth/jwt.ts', x: 'R', y: 'M', kind: 'renamed', staged: { added: 0, removed: 0, binary: false }, unstaged: { added: 3, removed: 1, binary: false } });
if (params.get('op')) repo.operation = params.get('op');
if (params.get('conflict')) {
  repo.operation = 'merge';
  repo.files.push({ path: 'a.txt', x: 'U', y: 'U', kind: 'conflict' });
}
// `git diff` of a file in conflict, verbatim: a column per parent.
const conflictDiff = 'diff --cc a.txt\nindex 2d33e85,2339517..0000000\n--- a/a.txt\n+++ b/a.txt\n@@@ -1,4 -1,3 +1,8 @@@\n  one\n++<<<<<<< HEAD\n +TWO main\n++=======\n+ TWO side\n++>>>>>>> side\n  three\n +four\n';
const commits = [
  { sha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', short: 'a1b2c3d', parents: ['b'], author: 'Ada', email: 'ada@example.com', date: now - 600, refs: ['HEAD -> feature/login', 'origin/feature/login'], subject: 'Check the password before the session is made' },
  { sha: 'b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1', short: 'b2c3d4e', parents: ['c'], author: 'Ada', email: 'ada@example.com', date: now - 7200, refs: [], subject: 'Add the login form' },
  { sha: 'c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2', short: 'c3d4e5f', parents: [], author: 'Grace', email: 'grace@example.com', date: now - 86400 * 3, refs: ['origin/main', 'main'], subject: 'Start' },
];
// ?many=1: a long history, so that "Older commits…" has pages to load.
const longHistory = Array.from({ length: 250 }, (_, i) => ({ ...commits[0], sha: String(i).padStart(40, '0'), short: String(i).padStart(7, '0'), subject: `Commit number ${i}` }));
const smallDiff = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -10,6 +10,8 @@ export function login(user: User) {\n   const hash = await digest(user.password);\n-  if (hash === stored) return true;\n+  if (!stored) throw new Error("no password set");\n+  if (timingSafeEqual(hash, stored)) {\n+    return makeSession(user);\n+  }\n   return false;\n }\n`;
const bigDiff = (path: string) =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,6500 @@\n${Array.from({ length: 6500 }, (_, i) => `+line ${i + 1}`).join('\n')}\n`;
const diffOf = (path: string) => (params.get('bigdiff') ? bigDiff(path) : smallDiff(path));
let branches = [
  { name: 'feature/login', remote: false, sha: 'a1b2c3d', upstream: 'origin/feature/login', ahead: 2, behind: 0, gone: false, current: true, date: now - 600, subject: 'Check the password before the session is made' },
  { name: 'main', remote: false, sha: 'c3d4e5f', upstream: 'origin/main', ahead: 0, behind: 3, gone: false, current: false, date: now - 86400 * 3, subject: 'Start' },
  { name: 'old/experiment', remote: false, sha: 'd4e5f6a', upstream: 'origin/old/experiment', ahead: 0, behind: 0, gone: true, current: false, date: now - 86400 * 40, subject: 'Try another store' },
  { name: 'origin/main', remote: true, sha: 'e5f6a7b', upstream: null, ahead: 0, behind: 0, gone: false, current: false, date: now - 3600, subject: 'Release 1.2' },
  { name: 'origin/feature/signup', remote: true, sha: 'f6a7b8c', upstream: null, ahead: 0, behind: 0, gone: false, current: false, date: now - 5000, subject: 'Signup page' },
];
const gh = params.get('gh') === 'off'
  ? { installed: false, authed: false, repo: null, url: null, defaultBranch: null, note: 'Install the GitHub CLI (gh) to see and open pull requests here' }
  : { installed: true, authed: true, repo: 'me/app', url: 'https://github.com/me/app', defaultBranch: 'main', baseRef: 'upstream/main' };
// The pull request opened here, once it is.
let created: any = null;
let logAsked = 0;
let pullsFailed = 0;
let currentFailed = 0;
const pulls = [
  { number: 41, title: 'Login with a password', author: { login: 'ada' }, headRefName: 'feature/login', baseRefName: 'main', isDraft: false, state: 'OPEN', updatedAt: new Date(Date.now() - 3600_000).toISOString(), url: 'https://github.com/me/app/pull/41', reviewDecision: 'REVIEW_REQUIRED', additions: 40, deletions: 6 },
  { number: 38, title: 'Dark mode for the settings', author: { login: 'grace' }, headRefName: 'feature/dark', baseRefName: 'main', isDraft: true, state: 'OPEN', updatedAt: new Date(Date.now() - 86400_000).toISOString(), url: 'https://github.com/me/app/pull/38' },
];

// ?fork=1: a pull request from a contributor's `main`, while `main` is what is checked out here.
if (params.get('fork')) pulls.unshift({ number: 43, title: 'Fix a typo from a fork', author: { login: 'bob' }, headRefName: 'main', baseRefName: 'main', isDraft: false, state: 'OPEN', updatedAt: new Date(Date.now() - 600_000).toISOString(), url: 'https://github.com/me/app/pull/43', isCrossRepository: true } as any);

const realFetch = window.fetch;
window.fetch = (async (input: any, init?: any) => {
  const url = String(input);
  if (!url.startsWith(ROUTES)) return realFetch(input, init);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method, url, body });
  const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  const path = url.replace(ROUTES, '').split('?')[0];
  const q = new URLSearchParams(url.split('?')[1] ?? '');
  // The clone in the folder: a repository of its own, on its own branch, with a change of its own.
  if (path === '' && q.get('repo') === 'tools/lib') {
    return reply({ repo: true, root: '/work/app/tools/lib', prefix: '', branch: 'trunk', head: '9'.repeat(40), upstream: null, ahead: 0, behind: 0, stashes: 0, operation: null, truncated: false, remotes: [], files: [{ path: 'src/lib.ts', x: '.', y: 'M', kind: 'changed', unstaged: { added: 2, removed: 1, binary: false } }] });
  }
  if (path === '/repos') {
    const around = params.get('repo') === 'none' ? [] : [{ path: '', name: 'app' }];
    return reply({ repos: [...around, ...(params.get('nested') ? [{ path: 'tools/lib', name: 'lib' }] : [])], truncated: false });
  }
  if (params.get('repo') === 'none' && path === '') return reply({ repo: false, folder: '/work/notes' });
  if (path === '' && (window as any).stateFails) return reply({ error: 'The portal could not be reached' }, 500);
  if (path === '') return reply({ repo: true, root: '/work/app', prefix: params.get('prefix') ?? '', ...repo, truncated: false, remotes: [{ name: 'origin', address: 'github.com:me/app', web: 'https://github.com/me/app' }] });
  if (path === '/gh') {
    // The clone is a repository of its own on GitHub, with another default branch; ?ghslow=1 is slow for the folder's own only.
    const clone = q.get('repo') === 'tools/lib';
    if (params.get('ghslow') && !clone) await new Promise((r) => setTimeout(r, 4000));
    return reply(clone && gh.repo ? { ...gh, repo: 'me/lib', url: 'https://github.com/me/lib', defaultBranch: 'trunk' } : gh);
  }
  if (path === '/diff') return reply({ diff: q.get('path') === 'a.txt' ? conflictDiff : diffOf(q.get('path') ?? 'x'), truncated: false });
  if (path === '/stage') {
    for (const f of repo.files) if (body.all || body.paths.includes(f.path)) Object.assign(f, { x: f.kind === 'untracked' ? 'A' : 'M', y: '.', kind: 'changed', staged: f.unstaged ?? { added: 1, removed: 0, binary: false }, unstaged: undefined });
    return reply({ ok: true });
  }
  if (path === '/unstage') {
    for (const f of repo.files) if (body.all || body.paths.includes(f.path)) Object.assign(f, { x: '.', y: 'M', unstaged: f.staged, staged: undefined });
    return reply({ ok: true });
  }
  if (path === '/discard') {
    repo.files = repo.files.filter((f) => !body.paths.includes(f.path) || f.x !== '.');
    return reply({ ok: true });
  }
  if (path === '/commit') {
    repo.files = repo.files.filter((f) => f.x === '.' || f.kind === 'untracked');
    repo.ahead++;
    return reply({ sha: 'f'.repeat(40) });
  }
  if (path === '/push') {
    if (params.get('push') === 'fail') return reply({ error: 'failed to push some refs to github.com:me/app\nUpdates were rejected because the remote contains work that you do not have locally.' }, 409);
    repo.ahead = 0;
    return reply({ said: 'To github.com:me/app\n   a1b2c3d..f000000  feature/login -> feature/login' });
  }
  if (path === '/log') {
    if (params.get('logfail') && logAsked++ === 0) return reply({ error: 'Unable to create index.lock: File exists' }, 409);
    if (params.get('many')) {
      await new Promise((r) => setTimeout(r, 300));
      const skip = Number(q.get('skip') ?? 0);
      return reply({ commits: longHistory.slice(skip, skip + Number(q.get('limit') ?? 100)) });
    }
    return reply({ commits });
  }
  if (path.startsWith('/commits/')) {
    const c = commits.find((x) => x.sha === path.slice(9))!;
    return reply({ ...c, committer: c.author, message: `${c.subject}\n\nWith a body that explains why.`, files: [{ path: 'src/auth/login.ts', status: 'M', added: 12, removed: 3, binary: false }, { path: 'src/auth/new.ts', status: 'A', added: 30, removed: 0, binary: false }] });
  }
  if (path === '/branches' && method === 'GET') return reply({ branches });
  if (path === '/branches' && method === 'POST') {
    repo.branch = body.name;
    return reply({ ok: true });
  }
  if (path === '/branches/delete') {
    // ?unmerged=1: git refuses the plain delete of a branch whose commits are on no other.
    if (params.get('unmerged') && !body.force) return reply({ error: `the branch '${body.name}' is not fully merged` }, 409);
    branches = branches.filter((b) => b.name !== body.name);
    return reply({ ok: true });
  }
  if (path === '/switch') {
    repo.branch = body.remote ? body.name.split('/').slice(1).join('/') : body.name;
    return reply({ ok: true });
  }
  if (path === '/stashes') return reply({ stashes: [{ ref: 'stash@{0}', sha: '5'.repeat(40), date: now - 4000, message: 'On feature/login: half a refactor' }] });
  if (path === '/compare' && q.get('base') === 'old/experiment') return reply({ error: 'old/experiment and HEAD have nothing in common' }, 409);
  if (path === '/compare' && params.get('comparefail')) return reply({ error: 'upstream/main and HEAD have nothing in common' }, 409);
  if (path === '/compare') return reply({ comparison: { base: 'origin/main', head: repo.branch, mergeBase: 'c3d4e5f', commits: commits.slice(0, 2), files: [{ path: 'src/auth/login.ts', status: 'M', added: 12, removed: 3, binary: false }] } });
  if (path === '/pulls' && method === 'GET') {
    if (params.get('pullsfail') && !pullsFailed++) return reply({ error: 'GitHub is not answering' }, 502);
    return reply({ pulls });
  }
  if (path === '/pulls/current' && params.get('currentfail') && !currentFailed++) return reply({ error: 'gh timed out' }, 502);
  // The clone's branch has no pull request.
  if (path === '/pulls/current' && q.get('repo') === 'tools/lib') return reply({ pull: null });
  if (path === '/pulls/current') return reply({ pull: repo.branch === 'feature/login' ? { ...pulls[0], body: '' } : created?.headRefName === repo.branch ? created : null });
  if (path === '/pulls' && method === 'POST') {
    created = { ...pulls[0], number: 42, title: body.title, headRefName: repo.branch, body: body.body };
    // ?prurl=odd: an answer with no number in it to read.
    return reply({ url: params.get('prurl') === 'odd' ? 'https://github.com/me/app/pulls' : 'https://github.com/me/app/pull/42' });
  }
  if (/^\/pulls\/\d+$/.test(path)) {
    const p = pulls.find((x) => String(x.number) === path.slice(7)) ?? { ...pulls[0], number: 42, title: 'New', headRefName: repo.branch };
    return reply({ pull: { ...p, body: 'Adds **login** with a password.\n\n- checks the hash in constant time', mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }, { name: 'lint', status: 'IN_PROGRESS' }], commits: [{ oid: commits[0].sha, messageHeadline: commits[0].subject }], comments: [{ author: { login: 'grace' }, body: 'Looks good — one question about the hash.', createdAt: new Date(Date.now() - 1800_000).toISOString() }], reviews: [] } });
  }
  if (/^\/pulls\/\d+\/diff$/.test(path)) {
    if (params.get('prdifffail')) return reply({ error: 'gh pr diff failed' }, 502);
    // ?prfiles=1: a file renamed with nothing changed in it, and one deleted, besides the two changed.
    const more = params.get('prfiles') ? 'diff --git a/src/auth/jwt.ts b/src/auth/token.ts\nsimilarity index 100%\nrename from src/auth/jwt.ts\nrename to src/auth/token.ts\ndiff --git a/src/auth/old.ts b/src/auth/old.ts\ndeleted file mode 100644\nindex 1..0\n--- a/src/auth/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n' : '';
    return reply({ diff: diffOf('src/auth/login.ts') + diffOf('src/auth/session.ts') + more, truncated: params.get('prtruncated') === '1' });
  }
  if (/^\/pulls\/\d+\/(merge|comment|review|checkout)$/.test(path)) return reply({ ok: true, said: '' });
  return reply({ ok: true });
}) as typeof fetch;

const chat = { id: 's', title: 'Login work', workspace: '/w/site' };

function Fixture() {
  const entry = useSlot('chat.panel').find((e) => e.name === 'git');
  // What the panel shares with its head (the tab), as the chat keeps it while the panel is open.
  const [state, setState] = useState<unknown>(params.get('tab') ? { tab: params.get('tab') } : undefined);
  // The chat's events: a file the agent wrote is one, and the panel looks again.
  const [events, setEvents] = useState<PortalEvent[]>([]);
  const [opened, setOpened] = useState<string[]>([]);
  const wrote = (path: string) =>
    setEvents((e) => [...e, { seq: e.length + 1, type: 'tool_execution_end', payload: { toolName: 'write', toolCallId: `w${e.length}`, input: { path } } }]);
  useLayoutEffect(
    () => publishChat('s', { events, items: [], calls: [], call: () => undefined, running: false, status: 'idle', loading: false, background: { supported: false, jobs: [], statuses: [], widgets: [] }, refreshBackground: () => {} }),
    [events],
  );
  (window as any).moveHead = () => {
    repo.head = 'e'.repeat(40);
    wrote('src/auth/login.ts');
  };
  (window as any).agentWrote = (path: string) => {
    repo.files.push({ path, x: '?', y: '?', kind: 'untracked' });
    wrote(path);
  };
  if (!entry) return null;
  const handle = { params: undefined, state, setState, keep: () => {}, guardClose: () => {}, open: (_name: string, given?: unknown) => setOpened((o) => [...o, String((given as { path?: string })?.path)]), fullscreen: () => {} };
  const props = { chat, channel: channelFor('s', entry.extension), panels: panelsFor(entry.extension), close: () => {}, panel: handle };
  const Head = entry.header!;
  const Body = entry.component;
  return (
    <div className="bg-canvas text-fg" style={{ height: '100vh', display: 'flex', flexDirection: 'column', maxWidth: 520 }}>
      <div style={{ padding: 6 }}>
        <Head {...props} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <Body {...props} />
      </div>
      <output data-testid="opened">{opened.join(',')}</output>
      <ConfirmHost />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
