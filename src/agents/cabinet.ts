'use agent';

import { defineSkill, useModel, useSkill, useTool } from '@flue/runtime';
import inventorySkill from '../../skills/general-inventory.md';
import { readTools } from '../tools/index.ts';

const skill = defineSkill({ name: 'general-inventory', description: 'Manage tenant inventory.', instructions: inventorySkill });

export function Cabinet() {
  useModel('cloudflare/@cf/moonshotai/kimi-k2.6');
  useSkill(skill);
  for (const tool of readTools) useTool(tool);
  return 'Handle the Telegram inventory request with the registered tools.';
}
