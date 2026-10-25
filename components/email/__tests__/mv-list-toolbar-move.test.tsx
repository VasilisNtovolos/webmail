import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MvListToolbar } from '../mv-list-toolbar';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { toast } from '@/stores/toast-store';
import { JMAPClient } from '@/lib/jmap/client';
import { clearAllHooks, emailHooks } from '@/lib/plugin-hooks';
import type { Email, Mailbox } from '@/lib/jmap/types';

const initial = useEmailStore.getState(), initialAuth = useAuthStore.getState();
const folder = (id: string): Mailbox => ({ id, name: id, accountId: 'owner',
  role: id === 'inbox' ? 'inbox' : undefined, myRights: { mayReadItems: true, mayAddItems: true } } as Mailbox);
let success: ReturnType<typeof vi.spyOn>, error: ReturnType<typeof vi.spyOn>;
let result: Record<string, unknown>, client: JMAPClient;
beforeEach(() => {
  clearAllHooks();
  client = JMAPClient.withBearer('https://toolbar.example.invalid', 'synthetic', 'test@example.invalid');
  Object.assign(client, { accountId: 'owner', apiUrl: 'https://toolbar.example.invalid/jmap/api' });
  success = vi.spyOn(toast, 'success').mockImplementation(() => {}); error = vi.spyOn(toast, 'error').mockImplementation(() => {});
  result = { updated: { a: null }, notUpdated: { b: { type: 'forbidden' } } };
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(url).toBe('https://toolbar.example.invalid/jmap/api');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic');
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ methodResponses: body.methodCalls.map(([method, , tag]: [string, unknown, string]) =>
      [method, method === 'Email/set' ? result : { list: [folder('inbox'), folder('dest')] }, tag]) }), { status: 200 });
  }));
  useAuthStore.setState({ ...initialAuth, client, activeAccountId: 'test', getClientForAccount: () => client });
  const rows = ['a', 'b'].map(id => ({ id, threadId: id, mailboxIds: { inbox: true }, keywords: {}, size: 100, receivedAt: '2026-10-01T00:00:00Z', hasAttachment: false } as Email));
  useEmailStore.setState({ ...initial, emails: rows, selectedEmailKeys: new Set(['a', 'b']),
    mailboxes: [folder('inbox'), folder('dest')], selectedMailbox: '__unified_inbox__', isUnifiedView: true,
    unifiedRole: 'inbox', viewingAccountId: null, selectedKeyword: null, searchQuery: '', crossView: null,
    threadEmailsCache: new Map(), expandedThreadIds: new Set(), error: null,
    refreshCurrentMailbox: vi.fn().mockResolvedValue(undefined) });
});
afterEach(() => {
  cleanup(); clearAllHooks(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  useEmailStore.setState(initial); useAuthStore.setState(initialAuth);
});
async function clickMove() {
  const action = vi.spyOn(useEmailStore.getState(), 'batchMoveToMailbox');
  render(<MvListToolbar loadedCount={2} onRefresh={() => {}} />);
  fireEvent.click(screen.getByLabelText('move_to'));
  await act(async () => {
    fireEvent.click(screen.getByText('dest'));
    await action.mock.results[0].value;
  });
  return action;
}
it.each(['partial', 'complete'] as const)('shows an error and no full-count success after %s failure through the real store', async failure => {
  if (failure === 'complete') result = { notUpdated: { a: { type: 'forbidden' }, b: { type: 'forbidden' } } };
  const action = await clickMove();
  await expect(action.mock.results[0].value).resolves.toBe(false);
  expect(error).toHaveBeenCalledWith('move_failed', expect.stringContaining('forbidden'));
  expect(success).not.toHaveBeenCalled();
});
it('propagates a real plugin veto without a success toast or request', async () => {
  emailHooks.onBeforeEmailMove.register('test', () => false);
  const action = await clickMove();
  await expect(action.mock.results[0].value).resolves.toBe(false);
  expect(success).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('shows success after every message is confirmed, including null-valued entries', async () => {
  result = { updated: { a: null, b: null } };
  const action = await clickMove();
  await expect(action.mock.results[0].value).resolves.toBe(true);
  expect(success).toHaveBeenCalledWith('emails_moved'); expect(error).not.toHaveBeenCalled();
});
