import { describe, expect, it } from 'vitest';

import { permitsProductionContractRotation } from '../../scripts/actual-production-contract-rotation.mjs';

const existingContract = {
  nonce: 'a'.repeat(64),
  budget: { syncId: 'budget-id', name: 'Household Budget' },
  sentinelPayee: {
    id: 'prior-sentinel-id',
    name: 'HF_PRODUCTION_V1_prior',
  },
};

function input(overrides = {}) {
  return {
    explicitlyAllowed: true,
    existingContract,
    nonce: existingContract.nonce,
    budget: existingContract.budget,
    liveProductionSentinels: [
      existingContract.sentinelPayee,
      { id: 'older-id', name: 'HF_PRODUCTION_V1_older' },
    ],
    ...overrides,
  };
}

describe('Actual production contract rotation', () => {
  it('permits an explicit rotation while retaining older sentinels', () => {
    expect(permitsProductionContractRotation(input())).toBe(true);
  });

  it('remains fail-closed without every continuity proof', () => {
    expect(
      permitsProductionContractRotation(input({ explicitlyAllowed: false })),
    ).toBe(false);
    expect(
      permitsProductionContractRotation(input({ existingContract: undefined })),
    ).toBe(false);
    expect(
      permitsProductionContractRotation(input({ nonce: 'b'.repeat(64) })),
    ).toBe(false);
    expect(
      permitsProductionContractRotation(
        input({ budget: { syncId: 'other', name: 'Household Budget' } }),
      ),
    ).toBe(false);
    expect(
      permitsProductionContractRotation(
        input({
          liveProductionSentinels: [
            { id: 'wrong-id', name: existingContract.sentinelPayee.name },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      permitsProductionContractRotation(
        input({
          liveProductionSentinels: [
            existingContract.sentinelPayee,
            {
              id: 'duplicate-id',
              name: existingContract.sentinelPayee.name,
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});
