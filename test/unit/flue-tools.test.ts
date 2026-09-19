import { describe, expect, it, vi } from 'vitest';

const registeredTools = vi.hoisted(() => [] as Array<{ name: string }>);

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('@flue/runtime', () => ({
  defineSkill: vi.fn(() => ({})),
  useModel: vi.fn(),
  useSkill: vi.fn(),
  useTool: vi.fn((tool) => registeredTools.push(tool)),
}));
vi.mock('../../skills/general-inventory.md', () => ({ default: '' }));

import { Cabinet } from '../../src/agents/cabinet.ts';

describe('Flue tool registration', () => {
  it('exposes exactly the four read tools', () => {
    Cabinet();

    expect(registeredTools.map(({ name }) => name)).toEqual([
      'check_stock',
      'list_low_stock',
      'get_item_history',
      'export_stock_report',
    ]);
  });
});
