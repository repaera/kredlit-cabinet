import * as v from 'valibot';

const UserSchema = v.object({ id: v.number(), username: v.optional(v.string()), first_name: v.optional(v.string(), '') });
const ChatSchema = v.object({ id: v.number(), type: v.string(), title: v.optional(v.string()) });

export const TelegramUpdateSchema = v.object({
  update_id: v.number(),
  message: v.optional(v.object({
    message_id: v.number(),
    chat: ChatSchema,
    from: UserSchema,
    text: v.optional(v.string()),
  })),
  callback_query: v.optional(v.object({
    id: v.string(),
    from: UserSchema,
    message: v.object({ chat: ChatSchema, message_id: v.number() }),
    data: v.string(),
  })),
});

export type TelegramUpdate = v.InferOutput<typeof TelegramUpdateSchema>;
