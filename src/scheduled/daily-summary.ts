import { createDb } from '../db/client.ts';
import type { Env } from '../env.ts';
import { sendMessage } from '../telegram/client.ts';

export async function dailySummary(env: Env): Promise<void> {
  const db = createDb(env.HYPERDRIVE.connectionString);
  try {
    const chats = await db<{ chat_id: string; lines: string }[]>`
      select tc.chat_id, string_agg(i.name || ' @ ' || l.name || ': ' || st.quantity::text, E'\n' order by l.name, i.name) lines
      from stock_transactions st join items i on i.id = st.item_id join locations l on l.id = st.location_id
      join telegram_chats tc on tc.tenant_id = st.tenant_id and tc.location_id is null
      where st.created_at >= date_trunc('day', now()) group by tc.chat_id`;
    for (const chat of chats) await sendMessage(env.TELEGRAM_BOT_TOKEN, { chatId: chat.chat_id, text: `Today's summary:\n${chat.lines}` });
  } finally {
    await db.end();
  }
}
