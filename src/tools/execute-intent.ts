import * as v from 'valibot';
import type { Db } from '../db/client.ts';
import { IntentQueueMessageSchema } from '../types/flow.ts';
import { ToolContextSchema, type WriteToolOutput } from '../types/tools.ts';
import { executeWriteTool, parseWriteToolOutput } from './execute.ts';

export async function executeQueuedIntent(db: Db, intent: unknown): Promise<WriteToolOutput> {
  const message = v.parse(IntentQueueMessageSchema, intent);
  const context = v.parse(ToolContextSchema, message.toolInput);
  if (context.tenantId !== message.tenantId || context.chatId !== message.chatId || context.userId !== message.userId) {
    throw new Error('Intent envelope and tool context do not match');
  }

  return db.begin(async (tx) => {
    const [claimed] = await tx<{ intent_id: string }[]>`
      insert into intent_executions (tenant_id, intent_id, tool_name)
      values (${message.tenantId}, ${message.id}, ${message.toolName})
      on conflict (tenant_id, intent_id) do nothing
      returning intent_id`;

    if (!claimed) {
      const [receipt] = await tx<{ tool_name: string; output: unknown; completed_at: Date | null }[]>`
        select tool_name, output, completed_at from intent_executions
        where tenant_id = ${message.tenantId} and intent_id = ${message.id}`;
      if (!receipt?.completed_at || receipt.output === null) throw new Error('Incomplete intent execution receipt');
      if (receipt.tool_name !== message.toolName) throw new Error('Intent ID reused for a different tool');
      return parseWriteToolOutput(message.toolName, receipt.output);
    }

    const output = await executeWriteTool(tx, message.toolName, message.toolInput);
    const completed = await tx`
      update intent_executions set output = ${tx.json(output as never)}, completed_at = now()
      where tenant_id = ${message.tenantId} and intent_id = ${message.id} and completed_at is null
      returning intent_id`;
    if (completed.length !== 1) throw new Error('Intent execution receipt was not completed');
    return output;
  });
}
