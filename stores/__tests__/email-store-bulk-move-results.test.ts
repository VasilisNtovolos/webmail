import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import { emailKeyFor, threadKeyFor } from '@/lib/thread-utils';
import { bumpStoreEpoch } from '@/lib/store-epoch';
import { useSettingsStore } from '../settings-store';
import { useAuthStore } from '../auth-store';
import { useEmailStore, resolveSelectedEmails } from '../email-store';
import type { Email, Mailbox } from '@/lib/jmap/types';

const initial = useEmailStore.getState(), initialAuth = useAuthStore.getState(), initialSettings = useSettingsStore.getState();
const email = (id: string, login?: string, owner = 'owner'): Email => ({
  id, threadId: `t-${id}`, sourceClientAccountId: login, sourceAccountId: login ? owner : undefined,
  receivedAt: '2026-10-01T00:00:00Z', mailboxIds: { inbox: true }, keywords: {}, size: 100, hasAttachment: false,
});
const folder = (id: string, owner = 'owner', shared = false, total = 2): Mailbox => ({
  id, accountId: owner, name: id, isShared: shared, role: id === 'inbox' ? 'inbox' : undefined,
  totalEmails: total, unreadEmails: total, totalThreads: total, unreadThreads: total,
  myRights: { mayReadItems: true, mayAddItems: true },
} as Mailbox);
const ok = (...ids: string[]) => ({ updated: Object.fromEntries(ids.map(id => [id, null])) });
const no = (id: string) => ({ notUpdated: { [id]: { type: 'forbidden', description: 'Move refused' } } });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};
function makeClient(login: string, max = 500) {
  const result = JMAPClient.withBearer(`https://${login}.example.invalid`, `token-${login}`, `${login}@example.invalid`);
  Object.assign(result, { accountId: 'owner', apiUrl: `https://${login}.example.invalid/jmap/api`,
    capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInSet: max } } });
  return result;
}
type Write = { login: string; owner: string; ids: string[] };
let a: JMAPClient, b: JMAPClient, clients: Map<string, JMAPClient>, writes: Write[], reads: string[];
let answer: (write: Write, n: number) => unknown | Promise<unknown>;
let refresh: ReturnType<typeof vi.fn<typeof initial.refreshCurrentMailbox>>;
let folders: (login: string, owner: string) => Mailbox[];
let moved: ReturnType<typeof vi.fn<(event: { emailIds: string[] }) => void>>;
let updates: Record<string, unknown>[];
function select(rows: Email[], selected = rows, unified = false) {
  useEmailStore.setState({ emails: rows, totalEmails: rows.length, selectedEmail: selected[0] ?? null,
    selectedEmailKeys: new Set(selected.map(emailKeyFor)), isUnifiedView: unified,
    unifiedRole: unified ? 'inbox' : null, selectedMailbox: unified ? '__unified_inbox__' : 'inbox' });
}
const selectedIds = () => resolveSelectedEmails(useEmailStore.getState()).map(emailKeyFor);
const move = () => useEmailStore.getState().batchMoveToMailbox(a, 'dest');
beforeEach(() => {
  clearAllHooks(); a = makeClient('a'); b = makeClient('b'); clients = new Map([['a', a], ['b', b]]);
  writes = []; reads = []; updates = []; answer = w => ok(...w.ids);
  folders = (_login, owner) => [folder('inbox', owner, owner !== 'owner', 1), folder('dest', owner, owner !== 'owner', 1)];
  refresh = vi.fn<typeof initial.refreshCurrentMailbox>().mockResolvedValue(undefined);
  moved = vi.fn(); emailHooks.onAfterEmailMove.register('test', moved);
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const login = new URL(String(url)).hostname.split('.')[0];
    expect(String(url)).toBe(`https://${login}.example.invalid/jmap/api`);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer token-${login}`);
    const body = JSON.parse(String(init?.body)) as { methodCalls: [string, { accountId: string; update: Record<string, unknown> }, string][] };
    const methodResponses = [];
    for (const [method, args, tag] of body.methodCalls) {
      if (method === 'Mailbox/get') {
        reads.push(`${login}/${args.accountId}`);
        methodResponses.push([method, { list: folders(login, args.accountId) }, tag]);
      } else {
        expect(method).toBe('Email/set');
        const write = { login, owner: args.accountId, ids: Object.keys(args.update) }; writes.push(write); updates.push(args.update);
        const result = await answer(write, writes.length);
        methodResponses.push([method, result, tag]);
      }
    }
    return json({ methodResponses });
  }));
  useAuthStore.setState({ ...initialAuth, client: a, activeAccountId: 'a', getClientForAccount: id => clients.get(id), getAllConnectedClients: () => new Map(clients) });
  useEmailStore.setState({ ...initial, viewingAccountId: null, selectedKeyword: null, searchQuery: '', crossView: null,
    mailboxes: [folder('inbox'), folder('dest')], accountMailboxes: {}, threadEmailsCache: new Map(), expandedThreadIds: new Set(),
    retainedInViewIds: new Set(), error: null, isLoading: false, refreshCurrentMailbox: refresh });
});
afterEach(() => {
  clearAllHooks(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  useEmailStore.setState(initial); useAuthStore.setState(initialAuth); useSettingsStore.setState(initialSettings);
});

describe('selected bulk Move reconciliation', () => {
  it.each([false, true])('reconciles only confirmations, preserving failed selection for retry (unified=%s)', async unified => {
    const accepted = email('a'), refused = email('b'); select([accepted, refused], undefined, unified);
    answer = () => ({ ...ok('a'), ...no('b') });
    expect(await move()).toBe(false);
    const s = useEmailStore.getState();
    expect(s.emails).toEqual([refused]); expect(selectedIds()).toEqual(['b']); expect(s.totalEmails).toBe(1);
    expect(s.error).toMatch(/Move refused/); expect(s.isLoading).toBe(false);
    expect(refresh).toHaveBeenCalledWith(a, { isCurrentView: expect.any(Function), throwOnError: true, preserveThreadCache: true }); expect(reads).toEqual(['a/owner']);
    expect(moved).toHaveBeenCalledExactlyOnceWith({ emailIds: ['a'], fromMailboxId: 'inbox', toMailboxId: 'dest' });
    answer = w => ok(...w.ids); writes = [];
    expect(await move()).toBe(true); expect(writes.map(w => w.ids)).toEqual([['b']]);
  });

  it.each([false, true])('retains the failed namesake on another authenticated client (primary stamped=%s)', async stamped => {
    const first = email('same', stamped ? 'a' : undefined), second = email('same', 'b'), other = email('other', 'a');
    select([first, second, other], [first, second]);
    answer = w => w.login === 'a' ? ok('same') : no('same');
    expect(await move()).toBe(false);
    expect(useEmailStore.getState().emails).toEqual([second, other]); expect(selectedIds()).toEqual([emailKeyFor(second)]);
    expect(writes).toEqual([{ login: 'a', owner: 'owner', ids: ['same'] }, { login: 'b', owner: 'owner', ids: ['same'] }]);
    expect(moved).toHaveBeenCalledExactlyOnceWith({ emailIds: ['same'], fromMailboxId: 'inbox', toMailboxId: 'dest' });
    expect(reads).toContain('a/owner');
  });

  it('keeps owners on one reaching client separate and normalizes refreshed shared folders', async () => {
    const own = email('same', 'a'), shared = email('same', 'a', 'shared');
    select([own, shared]); answer = w => w.owner === 'owner' ? ok('same') : no('same');
    expect(await move()).toBe(false); expect(selectedIds()).toEqual([emailKeyFor(shared)]);
    expect(useEmailStore.getState().emails).toEqual([shared]);
    select([shared]); answer = w => ok(...w.ids); expect(await move()).toBe(true);
    expect(useEmailStore.getState().accountMailboxes.a.find(m => m.accountId === 'shared')?.id).toBe('shared:inbox');
  });

  it('publishes owner counters to each login cache rather than a colliding owner-only cache', async () => {
    select([email('p', 'a'), email('q', 'b')]);
    folders = (login, owner) => [folder('inbox', owner, false, login === 'a' ? 8 : 19)];
    expect(await move()).toBe(true);
    const s = useEmailStore.getState();
    expect(s.mailboxes[0].totalEmails).toBe(8); expect(s.accountMailboxes.a[0].totalEmails).toBe(8);
    expect(s.accountMailboxes.b[0].totalEmails).toBe(19);
  });

  it.each(['rejected', 'transport'] as const)('preserves earlier chunks and excludes their confirmations from retry after %s', async failure => {
    a = makeClient('a', 1); clients.set('a', a); select(['a', 'b', 'c'].map(id => email(id)));
    answer = (w, n) => { if (n === 1) return ok(...w.ids); if (failure === 'transport') throw new Error('lost response'); return no(w.ids[0]); };
    expect(await move()).toBe(false); expect(selectedIds()).toEqual(['b', 'c']);
    expect(writes.map(w => w.ids)).toEqual(failure === 'transport' ? [['a'], ['b']] : [['a'], ['b'], ['c']]);
    answer = w => ok(...w.ids); writes = [];
    expect(await move()).toBe(true); expect(writes.map(w => w.ids)).toEqual([['b'], ['c']]);
  });

  it('keeps omitted confirmations selected and emits only confirmed IDs', async () => {
    select([email('a'), email('b')]); answer = () => ok('a');
    expect(await move()).toBe(false); expect(selectedIds()).toEqual(['b']);
    expect(useEmailStore.getState().error).toMatch(/not confirmed/);
    expect(moved.mock.calls[0][0].emailIds).toEqual(['a']);
  });

  it.each([false, true])('does not remove or report any success after complete rejection (unified=%s)', async unified => {
    const rows = [email('a'), email('b')]; select(rows, undefined, unified); answer = () => ({ ...no('a'), notUpdated: { a: { type: 'forbidden' }, b: { type: 'forbidden' } } });
    expect(await move()).toBe(false); expect(useEmailStore.getState().emails).toEqual(rows); expect(selectedIds()).toEqual(['a', 'b']);
    expect(moved).not.toHaveBeenCalled(); expect(useEmailStore.getState().error).toMatch(/forbidden/);
  });

  it('cleans confirmed viewer/cache/expansion/retained state while preserving a failed cached-only namesake', async () => {
    const accepted = email('same', 'a'), refused = email('same', 'b'), unrelated = email('row', 'b');
    select([accepted, unrelated], [accepted, refused]);
    useEmailStore.setState({ selectedEmail: { ...accepted }, retainedInViewIds: new Set(['same']),
      threadEmailsCache: new Map([[threadKeyFor(accepted), [accepted]], [threadKeyFor(refused), [refused]]]),
      expandedThreadIds: new Set([threadKeyFor(accepted), threadKeyFor(refused)]) });
    answer = w => w.login === 'a' ? ok('same') : no('same');
    expect(await move()).toBe(false);
    const s = useEmailStore.getState(); expect(s.selectedEmail).toBeNull(); expect(selectedIds()).toEqual([emailKeyFor(refused)]);
    expect(s.threadEmailsCache.has(threadKeyFor(accepted))).toBe(false);
    expect(s.threadEmailsCache.get(threadKeyFor(refused))).toEqual([refused]);
    expect([...s.expandedThreadIds]).toEqual([threadKeyFor(refused)]);
    // A raw retained ID is still needed by its failed cached namesake.
    expect(s.retainedInViewIds.has('same')).toBe(true);
  });

  it('keeps mixed threads expanded and does not close a failed viewer', async () => {
    const accepted = email('a'), refused = { ...email('b'), threadId: 't-a' }; select([accepted, refused]);
    useEmailStore.setState({ selectedEmail: refused, threadEmailsCache: new Map([['t-a', [accepted, refused]]]), expandedThreadIds: new Set(['t-a']) });
    answer = () => ({ ...ok('a'), ...no('b') }); expect(await move()).toBe(false);
    const s = useEmailStore.getState(); expect(s.selectedEmail).toBe(refused);
    expect(s.threadEmailsCache.get('t-a')).toEqual([refused]); expect(s.expandedThreadIds.has('t-a')).toBe(true);
  });

  it('reconciles an unstamped list row and its stamped viewer as the same client/owner', async () => {
    select([email('a')]); useEmailStore.setState({ selectedEmail: email('a', 'a') });
    expect(await move()).toBe(true); expect(useEmailStore.getState().selectedEmail).toBeNull();
  });

  it('handles unloaded explicit rule targets without touching loaded namesakes or their selection', async () => {
    const namesake = email('same', 'a'); select([namesake]);
    expect(await useEmailStore.getState().batchMoveToMailbox(a, 'dest', { client: b, accountId: 'shared', emailIds: ['same', 'unloaded'] })).toBe(true);
    expect(writes).toEqual([{ login: 'b', owner: 'shared', ids: ['same', 'unloaded'] }]);
    expect(useEmailStore.getState().emails).toEqual([namesake]); expect(selectedIds()).toEqual([emailKeyFor(namesake)]);
    expect(useEmailStore.getState().selectedEmail).toBe(namesake); expect(reads).toEqual(['b/shared']);
    expect(moved.mock.calls[0][0].emailIds).toEqual(['same', 'unloaded']);
  });

  it('reconciles only confirmed explicit targets, including a selected cached-only member', async () => {
    const accepted = email('same', 'b', 'shared'), refused = email('failed', 'b', 'shared'), other = email('same', 'a');
    select([other, refused], [accepted, refused]);
    useEmailStore.setState({ threadEmailsCache: new Map([[threadKeyFor(accepted), [accepted]]]) });
    answer = () => ({ ...ok('same', 'unloaded'), ...no('failed') });
    expect(await useEmailStore.getState().batchMoveToMailbox(a, 'dest', { client: b, accountId: 'shared', emailIds: ['same', 'failed', 'unloaded'] })).toBe(false);
    expect(useEmailStore.getState().emails).toEqual([other, refused]); expect(selectedIds()).toEqual([emailKeyFor(refused)]);
  });

  it('uses the real empty-page refresh without leaving stale viewer, caches or total', async () => {
    const accepted = email('a'); select([accepted]);
    useEmailStore.setState({ refreshCurrentMailbox: initial.refreshCurrentMailbox, threadEmailsCache: new Map([['t-a', [accepted]]]), expandedThreadIds: new Set(['t-a']), retainedInViewIds: new Set(['a']), hasMoreEmails: true });
    const query = vi.spyOn(a, 'getEmails').mockResolvedValue({ emails: [], total: 0, hasMore: false });
    expect(await move()).toBe(true); expect(query).toHaveBeenCalled();
    const s = useEmailStore.getState(); expect(s.totalEmails).toBe(0); expect(s.selectedEmail).toBeNull();
    expect(s.threadEmailsCache.size).toBe(0); expect(s.expandedThreadIds.size).toBe(0); expect(s.retainedInViewIds.size).toBe(0); expect(s.hasMoreEmails).toBe(false);
  });

  it('preserves selected failures after the real refresh omits them from the first page', async () => {
    const accepted = email('a'), refused = email('b'); select([accepted, refused]); answer = () => ({ ...ok('a'), ...no('b') });
    useEmailStore.setState({ refreshCurrentMailbox: initial.refreshCurrentMailbox });
    vi.spyOn(a, 'getEmails').mockResolvedValue({ emails: [], total: 0, hasMore: false });
    vi.spyOn(a, 'getThreads').mockResolvedValue([]);
    expect(await move()).toBe(false); expect(selectedIds()).toEqual(['b']); expect(useEmailStore.getState().emails).toEqual([refused]);
    expect(useEmailStore.getState().error).toMatch(/Move refused/); expect(useEmailStore.getState().totalEmails).toBe(1);
  });

  it('preserves the move error and failed cached selection through refresh failure', async () => {
    const accepted = email('a'), refused = email('b'); select([accepted], [accepted, refused]);
    useEmailStore.setState({ threadEmailsCache: new Map([['t-b', [refused]]]) });
    answer = () => ({ ...ok('a'), ...no('b') }); refresh.mockRejectedValueOnce(new Error('refresh failed'));
    expect(await move()).toBe(false); expect(selectedIds()).toEqual(['b']); expect(useEmailStore.getState().error).toMatch(/Move refused/);
  });

  it('reports an owner refresh failure without undoing confirmations', async () => {
    select([email('a')]); folders = () => { throw new Error('mailbox refresh failed'); };
    expect(await move()).toBe(false); expect(useEmailStore.getState().emails).toEqual([]); expect(selectedIds()).toEqual([]);
    expect(useEmailStore.getState().error).toMatch(/mailbox refresh failed/);
  });

  it('waits for a slower sibling before clearing loading or reconciling successes', async () => {
    const slow = deferred<unknown>(); select([email('a', 'a'), email('b', 'b')]);
    answer = w => w.login === 'a' ? no('a') : slow.promise;
    let finished = false; const operation = move().then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(writes).toHaveLength(2)); await new Promise(resolve => setTimeout(resolve, 0));
    expect(finished).toBe(false); expect(useEmailStore.getState().isLoading).toBe(true);
    slow.resolve(ok('b')); expect(await operation).toBe(false); expect(selectedIds()).toEqual(['a/owner:a']);
  });

  it.each(['folder', 'search', 'epoch'] as const)('does not overwrite a new %s view when a response arrives', async change => {
    const pending = deferred<unknown>(); select([email('a')]); answer = () => pending.promise;
    const operation = move(); await vi.waitFor(() => expect(writes).toHaveLength(1));
    const other = email('other'); useEmailStore.setState({ emails: [other], selectedEmail: other, selectedEmailKeys: new Set(['other']), totalEmails: 1 });
    if (change === 'folder') useEmailStore.setState({ selectedMailbox: 'another-folder' });
    if (change === 'search') useEmailStore.setState({ searchQuery: 'another-search' });
    if (change === 'epoch') bumpStoreEpoch();
    pending.resolve(ok('a')); expect(await operation).toBe(true);
    expect(useEmailStore.getState().emails).toEqual([other]); expect(selectedIds()).toEqual(['other']);
    expect(useEmailStore.getState().selectedEmail).toBe(other); expect(refresh).not.toHaveBeenCalled();
  });

  it('does not resurrect deselected failures or clear a new unrelated selection during refresh', async () => {
    const accepted = email('a'), refused = email('b'), other = email('other'); select([accepted, refused, other], [accepted, refused]);
    answer = () => ({ ...ok('a'), ...no('b') });
    refresh.mockImplementationOnce(async () => { useEmailStore.setState({ selectedEmailKeys: new Set(['other']) }); });
    expect(await move()).toBe(false); expect(selectedIds()).toEqual(['other']);
  });

  it('preserves a newly selected unrelated row even if a pending refresh omits it', async () => {
    const pending = deferred<void>(); select([email('a'), email('b')]); answer = () => ({ ...ok('a'), ...no('b') });
    refresh.mockImplementationOnce(async () => { await pending.promise; useEmailStore.setState({ emails: [], threadEmailsCache: new Map() }); });
    const operation = move(); await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    const other = email('other'); useEmailStore.setState({ emails: [other], selectedEmailKeys: new Set(['other']) });
    pending.resolve(); expect(await operation).toBe(false); expect(selectedIds()).toEqual(['other']);
    expect(useEmailStore.getState().emails).toEqual([other]);
  });

  it('does not infer success from a lost response, and refreshes the potentially affected owner', async () => {
    const rows = [email('a'), email('b')]; select(rows); answer = () => { throw new Error('answer lost'); };
    expect(await move()).toBe(false); expect(selectedIds()).toEqual(['a', 'b']); expect(moved).not.toHaveBeenCalled();
    expect(reads).toEqual(['a/owner']); expect(refresh).toHaveBeenCalled();
  });

  it('preserves a veto with no writes, refresh or success notifications', async () => {
    const rows = [email('a')]; select(rows); emailHooks.onBeforeEmailMove.register('test', () => false);
    expect(await move()).toBe(false); expect(writes).toEqual([]); expect(reads).toEqual([]);
    expect(refresh).not.toHaveBeenCalled(); expect(moved).not.toHaveBeenCalled(); expect(selectedIds()).toEqual(['a']);
  });
});

it('retains the move error and failed selection when the actual view refresh rejects', async () => {
  select([email('a'), email('b')]); answer = () => ({ ...ok('a'), ...no('b') });
  useEmailStore.setState({ refreshCurrentMailbox: initial.refreshCurrentMailbox });
  vi.spyOn(a, 'getEmails').mockRejectedValue(new Error('list refresh failed'));
  expect(await move()).toBe(false); expect(selectedIds()).toEqual(['b']);
  expect(useEmailStore.getState().error).toMatch(/Move refused/);
});

it('does not clear a new unrelated selection made before the Move response', async () => {
  const pending = deferred<unknown>(); select([email('a'), email('b'), email('other')], [email('a'), email('b')]); answer = () => pending.promise;
  const operation = move(); await vi.waitFor(() => expect(writes).toHaveLength(1));
  useEmailStore.setState({ selectedEmailKeys: new Set(['other']) });
  pending.resolve({ ...ok('a'), ...no('b') }); expect(await operation).toBe(false);
  expect(selectedIds()).toEqual(['other']);
});

it('reports failure of the actual refresh after a fully confirmed Move without retrying confirmed IDs', async () => {
  select([email('a')]); useEmailStore.setState({ refreshCurrentMailbox: initial.refreshCurrentMailbox });
  vi.spyOn(a, 'getEmails').mockRejectedValue(new Error('list refresh failed'));
  expect(await move()).toBe(false); expect(selectedIds()).toEqual([]);
  expect(useEmailStore.getState().error).toMatch(/list refresh failed/);
});

it('guards the actual refresh when a new search opens while its query is pending', async () => {
  select([email('a')]); useEmailStore.setState({ refreshCurrentMailbox: initial.refreshCurrentMailbox });
  const pending = deferred<{ emails: Email[]; total: number; hasMore: boolean }>();
  const query = vi.spyOn(a, 'getEmails').mockReturnValue(pending.promise);
  const operation = move(); await vi.waitFor(() => expect(query).toHaveBeenCalled());
  const other = email('other'); useEmailStore.setState({ searchQuery: 'new search', emails: [other], selectedEmailKeys: new Set(['other']), totalEmails: 1 });
  pending.resolve({ emails: [], total: 0, hasMore: false }); expect(await operation).toBe(true);
  expect(useEmailStore.getState().emails).toEqual([other]); expect(selectedIds()).toEqual(['other']);
});

it('does not duplicate a failed selected row when refresh adds source stamps to it', async () => {
  const accepted = email('a'), refused = email('b'); select([accepted, refused]);
  answer = () => ({ ...ok('a'), ...no('b') });
  refresh.mockImplementationOnce(async () => { useEmailStore.setState({ emails: [email('b', 'a')], totalEmails: 1 }); });
  expect(await move()).toBe(false); expect(selectedIds()).toEqual(['b']);
  expect(useEmailStore.getState().emails).toEqual([refused]); expect(useEmailStore.getState().totalEmails).toBe(1);
});

it('preserves reconciled mixed-thread members through a real empty refresh without refetching moved members', async () => {
  const accepted = email('a'), refused = { ...email('b'), threadId: 't-a' }, sibling = { ...email('other'), threadId: 't-a' };
  select([accepted, refused]); answer = () => ({ ...ok('a'), ...no('b') });
  useEmailStore.setState({ refreshCurrentMailbox: initial.refreshCurrentMailbox,
    threadEmailsCache: new Map([['t-a', [accepted, refused, sibling]]]), expandedThreadIds: new Set(['t-a']) });
  vi.spyOn(a, 'getEmails').mockResolvedValue({ emails: [], total: 0, hasMore: false });
  const thread = vi.spyOn(a, 'getThreadEmails').mockResolvedValue([accepted, refused, sibling]);
  expect(await move()).toBe(false);
  expect(useEmailStore.getState().threadEmailsCache.get('t-a')).toEqual([refused, sibling]);
  expect(useEmailStore.getState().expandedThreadIds.has('t-a')).toBe(true);
  expect(thread).not.toHaveBeenCalled(); expect(selectedIds()).toEqual(['b']);
});

it.each([
  'existing selection', 'new selection', 'different owners', 'disconnected clients', 'unresolved owners',
] as const)('preserves unrelated refreshed namesakes outside Move groups: %s', async scenario => {
  const c = makeClient('c'); clients.set('c', c);
  let retained = email('same', 'b'), refreshed = email('same', 'c');
  if (scenario === 'different owners') refreshed = email('same', 'b', 'another-owner');
  if (scenario === 'disconnected clients') { clients.delete('b'); clients.delete('c'); }
  if (scenario === 'unresolved owners') {
    clients.set('alias-b', b); vi.spyOn(b, 'getAccountId').mockReturnValue('');
    retained = { ...retained, sourceAccountId: undefined };
    refreshed = { ...email('same', 'alias-b'), sourceAccountId: undefined };
  }
  const pending = deferred<void>();
  refresh.mockImplementationOnce(async () => {
    await pending.promise;
    useEmailStore.setState({ emails: [refreshed], totalEmails: 1 });
  });
  const movedEmail = email('move', 'a');
  select(scenario === 'new selection' ? [movedEmail] : [retained]);
  const operation = scenario === 'new selection' ? move()
    : useEmailStore.getState().batchMoveToMailbox(a, 'dest', { client: a, accountId: 'owner', emailIds: ['move'] });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  if (scenario === 'new selection') useEmailStore.setState({ emails: [retained], selectedEmail: retained,
    selectedEmailKeys: new Set([emailKeyFor(retained)]) });
  pending.resolve(); expect(await operation).toBe(true);
  const state = useEmailStore.getState();
  expect(state.emails).toEqual([refreshed, retained]);
  expect(state.emails[0]).toBe(refreshed); expect(state.emails[1]).toBe(retained);
  expect(selectedIds()).toEqual([emailKeyFor(retained)]);
  expect(state.selectedEmail).toBe(retained); expect(state.totalEmails).toBe(2);
  expect(writes).toEqual([{ login: 'a', owner: 'owner', ids: ['move'] }]);
});

it('matches an unrelated retained row to its stamped identity without replacing a refreshed client namesake', async () => {
  clients.set('c', makeClient('c'));
  const retained = email('same'), refreshed = email('same', 'b'), namesake = email('same', 'c');
  select([retained]); useEmailStore.setState({ viewingAccountId: 'b' });
  const pending = deferred<void>();
  refresh.mockImplementationOnce(async () => {
    await pending.promise;
    useEmailStore.setState({ emails: [namesake, refreshed], totalEmails: 2 });
  });
  const operation = useEmailStore.getState().batchMoveToMailbox(a, 'dest', { client: a, accountId: 'owner', emailIds: ['move'] });
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
  pending.resolve(); expect(await operation).toBe(true);
  expect(useEmailStore.getState().emails).toEqual([namesake, retained]);
  expect(selectedIds()).toEqual(['same']); expect(useEmailStore.getState().totalEmails).toBe(2);
});

it('reconciles an aggregate in-place partial result alongside upstream cross-account transfers', async () => {
  const accepted = email('accepted', 'a'), refused = email('refused', 'a'), foreign = email('foreign', 'b');
  select([accepted, refused, foreign], undefined, true);
  const memberKey = threadKeyFor(accepted);
  useEmailStore.setState({ selectedEmail: accepted,
    threadEmailsCache: new Map([[memberKey, [accepted]]]), expandedThreadIds: new Set([memberKey]) });
  answer = () => ({ ...ok('accepted'), ...no('refused') });
  const transfer = vi.fn<typeof initial.crossAccountMoveEmails>().mockResolvedValue(true);
  useEmailStore.setState({ crossAccountMoveEmails: transfer });
  expect(await move()).toBe(false);
  expect(writes).toEqual([{ login: 'a', owner: 'owner', ids: ['accepted', 'refused'] }]);
  expect(transfer).toHaveBeenCalledExactlyOnceWith(new Map([['b', ['foreign']]]), 'a', 'dest', undefined, 'owner');
  // Transfers own their local reconciliation and notification; the in-place
  // result must not guess at them or emit a duplicate transfer notification.
  expect(useEmailStore.getState().emails).toEqual([refused, foreign]);
  expect(selectedIds()).toEqual([emailKeyFor(refused), emailKeyFor(foreign)]);
  expect(useEmailStore.getState().selectedEmail).toBeNull();
  expect(useEmailStore.getState().threadEmailsCache.has(memberKey)).toBe(false);
  expect(useEmailStore.getState().error).toMatch(/Move refused/);
  expect(moved).toHaveBeenCalledExactlyOnceWith({ emailIds: ['accepted'], fromMailboxId: 'inbox', toMailboxId: 'dest' });
  expect(reads).toEqual(['a/owner']);
});

it('retains unresolved aggregate selection keys beside a confirmed in-place result', async () => {
  const accepted = email('accepted', 'a'); select([accepted], undefined, true);
  const missing = emailKeyFor(email('missing', 'b'));
  useEmailStore.setState({ selectedEmailKeys: new Set([emailKeyFor(accepted), missing]) });
  expect(await move()).toBe(false);
  expect(useEmailStore.getState().selectedEmailKeys).toEqual(new Set([missing]));
  expect(useEmailStore.getState().error).toBe('Message not found in the list');
  expect(writes).toEqual([{ login: 'a', owner: 'owner', ids: ['accepted'] }]);
  expect(moved.mock.calls[0][0].emailIds).toEqual(['accepted']);
});

it('refreshes upstream login/owner caches without overwriting a colliding owner on another client', async () => {
  const accepted = email('accepted', 'a'), untouched = folder('inbox', 'owner', false, 17);
  select([accepted], undefined, true);
  clients.set('alias-a', a);
  useEmailStore.setState({ accountMailboxes: {
    'a|owner': [folder('inbox', 'owner', false, 99)],
    'alias-a|owner': [folder('inbox', 'owner', false, 99)],
    'b|owner': [untouched],
    'a|shared': [folder('shared:inbox', 'shared', true, 23)],
  } });
  folders = () => [folder('inbox', 'owner', false, 8)];
  expect(await move()).toBe(true);
  const caches = useEmailStore.getState().accountMailboxes;
  expect(caches['a|owner'][0].totalEmails).toBe(8);
  expect(caches['alias-a|owner']).toEqual(caches['a|owner']);
  expect(caches['b|owner']).toEqual([untouched]);
  expect(caches['a|shared'][0].totalEmails).toBe(23);
});

it.each([0, 1])('keeps read pagination separate from the Unread section after Move (server total=%s)', async total => {
  const accepted = email('moved'), unread = [email('u1'), email('u2')], read = { ...email('read'), keywords: { $seen: true } };
  select([accepted, ...unread, read], [accepted]);
  useSettingsStore.setState({ interfaceLayout: 'mountain-view', mvInboxType: 'unread-first', messageListOrder: [] });
  useEmailStore.setState({ refreshCurrentMailbox: initial.refreshCurrentMailbox, totalEmails: 2,
    unreadSection: { mailboxId: 'inbox', ids: new Set(['u1', 'u2']), total: 2 } });
  vi.spyOn(a, 'getEmails').mockResolvedValueOnce({ emails: [read], total, hasMore: total === 0 })
    .mockResolvedValueOnce({ emails: unread, total: 2, hasMore: false });
  expect(await move()).toBe(true);
  const state = useEmailStore.getState();
  expect(state.emails).toEqual([...unread, read]);
  expect(state.totalEmails).toBe(1); expect(state.hasMoreEmails).toBe(total === 0);
});
