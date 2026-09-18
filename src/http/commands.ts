import type { Db } from '../db/client.ts';

export async function start(db: Db, chatId: string, telegramUserId: string, displayName: string, groupTitle?: string): Promise<string> {
  const [existing] = await db<{ tenant_id: string }[]>`select tenant_id from telegram_chats where chat_id = ${chatId}`;
  if (existing) {
    await db`insert into users (tenant_id, telegram_user_id, display_name) values (${existing.tenant_id}, ${telegramUserId}, ${displayName}) on conflict (tenant_id, telegram_user_id) do update set display_name = excluded.display_name`;
    return '✅ Cabinet is ready\n\nKredlit Cabinet is already set up for this group.';
  }
  try {
    await db.begin(async (tx) => {
      const [tenant] = await tx<{ id: string }[]>`insert into tenants (name) values (${groupTitle ?? `Telegram ${chatId}`}) returning id`;
      await tx`insert into telegram_chats (chat_id, tenant_id) values (${chatId}, ${tenant.id})`;
      await tx`insert into users (tenant_id, telegram_user_id, display_name) values (${tenant.id}, ${telegramUserId}, ${displayName})`;
    });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== '23505') throw error;
  }
  return "👋 Welcome to Kredlit Cabinet!\n\nThis group is now your main inventory chat.\n\nAdd your locations to get started, for example:\nlokasi: Toko A, Gudang A, Website, Shopee";
}

export async function link(db: Db, chatId: string, telegramUserId: string, locationName: string): Promise<string> {
  const memberships = await db<{ tenant_id: string }[]>`select distinct tenant_id from users where telegram_user_id = ${telegramUserId} limit 2`;
  if (memberships.length !== 1) return '⚠️ Tenant not found\n\nRun /start in a main inventory group first.';
  const [location] = await db<{ id: string; name: string }[]>`select id, name from locations where tenant_id = ${memberships[0].tenant_id} and lower(name) = lower(${locationName})`;
  if (!location) return `⚠️ Location not found\n\n${locationName}`;
  await db`insert into telegram_chats (chat_id, tenant_id, location_id) values (${chatId}, ${memberships[0].tenant_id}, ${location.id}) on conflict (chat_id) do update set tenant_id = excluded.tenant_id, location_id = excluded.location_id`;
  return `📍 Group linked\n\nThis group is now dedicated to ${location.name}.`;
}
