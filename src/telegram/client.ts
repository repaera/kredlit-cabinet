import * as v from 'valibot';

const ReplySchema = v.object({
  chatId: v.string(),
  text: v.string(),
  replyMarkup: v.optional(v.object({ inlineKeyboard: v.array(v.array(v.object({ text: v.string(), callbackData: v.string() }))) })),
});

async function telegram(token: string, method: string, body: BodyInit): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body, headers: body instanceof FormData ? undefined : { 'content-type': 'application/json' } });
  if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`);
  await response.body?.cancel();
}

export async function sendMessage(token: string, input: unknown): Promise<void> {
  const payload = v.parse(ReplySchema, input);
  await telegram(token, 'sendMessage', JSON.stringify({
    chat_id: payload.chatId,
    text: payload.text,
    ...(payload.replyMarkup ? { reply_markup: { inline_keyboard: payload.replyMarkup.inlineKeyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) } } : {}),
  }));
}

export async function answerCallbackQuery(token: string, callbackQueryId: string): Promise<void> {
  await telegram(token, 'answerCallbackQuery', JSON.stringify({ callback_query_id: callbackQueryId }));
}

export async function editMessageReplyMarkup(token: string, chatId: string, messageId: number): Promise<void> {
  await telegram(token, 'editMessageReplyMarkup', JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }));
}

export async function sendDocument(token: string, payload: { chatId: string; fileName: string; fileBytes: Uint8Array; caption?: string }): Promise<void> {
  const form = new FormData();
  form.set('chat_id', payload.chatId);
  if (payload.caption) form.set('caption', payload.caption);
  form.set('document', new File([new Uint8Array(payload.fileBytes).buffer as ArrayBuffer], payload.fileName, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  await telegram(token, 'sendDocument', form);
}
