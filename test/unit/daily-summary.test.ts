import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  end: vi.fn(),
  query: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../../src/db/client.ts', () => ({
  createDb: () => Object.assign((strings: TemplateStringsArray) => mocks.query(strings.join('?')), { end: mocks.end }),
}));
vi.mock('../../src/telegram/client.ts', () => ({ sendMessage: mocks.sendMessage }));

import { dailySummary } from '../../src/scheduled/daily-summary.ts';

beforeEach(() => vi.clearAllMocks());

describe('dailySummary', () => {
  it('routes each tenant-wide chat its formatted daily lines and closes the database', async () => {
    mocks.query.mockResolvedValue([
      { chat_id: '-1001', lines: 'Soap @ Store: -2\nSoap @ Warehouse: 10' },
      { chat_id: '-2002', lines: 'Rice @ Depot: 5' },
    ]);

    await dailySummary({ HYPERDRIVE: { connectionString: 'postgres://test' }, TELEGRAM_BOT_TOKEN: 'token' } as never);

    expect(mocks.sendMessage).toHaveBeenNthCalledWith(1, 'token', { chatId: '-1001', text: "Today's summary:\nSoap @ Store: -2\nSoap @ Warehouse: 10" });
    expect(mocks.sendMessage).toHaveBeenNthCalledWith(2, 'token', { chatId: '-2002', text: "Today's summary:\nRice @ Depot: 5" });
    expect(mocks.query.mock.calls[0][0]).toContain('tc.tenant_id = st.tenant_id');
    expect(mocks.query.mock.calls[0][0]).toContain('tc.location_id is null');
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('closes the database when Telegram delivery fails', async () => {
    mocks.query.mockResolvedValue([{ chat_id: '-1001', lines: 'Soap @ Store: 2' }]);
    mocks.sendMessage.mockRejectedValue(new Error('Telegram unavailable'));

    await expect(dailySummary({ HYPERDRIVE: { connectionString: 'postgres://test' }, TELEGRAM_BOT_TOKEN: 'token' } as never)).rejects.toThrow('Telegram unavailable');
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
