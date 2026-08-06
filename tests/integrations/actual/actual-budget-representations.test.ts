import { describe, expect, it } from 'vitest';

import {
  ActualBudgetRepresentationError,
  actualBudgetIdentityAppearsInRepresentations,
  actualBudgetIdentityKey,
  collapseActualBudgetRepresentations,
} from '../../../src/integrations/actual/index.js';

const budgetName = 'Household Finance Synthetic Test';

describe('Actual budget representations', () => {
  it('collapses matching local and remote rows and trusts the remote name', () => {
    const collapsed = collapseActualBudgetRepresentations([
      {
        source: 'local',
        id: 'local-id',
        cloudFileId: 'cloud-id',
        groupId: 'group-id',
        name: 'Stale local name',
      },
      {
        source: 'remote',
        cloudFileId: 'cloud-id',
        groupId: 'group-id',
        name: budgetName,
      },
    ]);

    expect(collapsed).toEqual([
      {
        id: 'local-id',
        cloudFileId: 'cloud-id',
        groupId: 'group-id',
        name: budgetName,
        localRepresentationPresent: true,
        remoteRepresentationPresent: true,
      },
    ]);
    expect(actualBudgetIdentityKey(collapsed[0]!)).toBe(
      JSON.stringify(['remote', 'cloud-id', 'group-id']),
    );
  });

  it('keeps same-named budgets with different complete identities separate', () => {
    expect(
      collapseActualBudgetRepresentations([
        {
          source: 'remote',
          cloudFileId: 'cloud-a',
          groupId: 'group-a',
          name: budgetName,
        },
        {
          source: 'remote',
          cloudFileId: 'cloud-b',
          groupId: 'group-b',
          name: budgetName,
        },
      ]),
    ).toHaveLength(2);
  });

  it.each([
    [
      'cloud identity collision',
      [
        {
          source: 'remote',
          cloudFileId: 'cloud-a',
          groupId: 'group-a',
          name: budgetName,
        },
        {
          source: 'remote',
          cloudFileId: 'cloud-a',
          groupId: 'group-b',
          name: budgetName,
        },
      ],
    ],
    [
      'group identity collision',
      [
        {
          source: 'remote',
          cloudFileId: 'cloud-a',
          groupId: 'group-a',
          name: budgetName,
        },
        {
          source: 'remote',
          cloudFileId: 'cloud-b',
          groupId: 'group-a',
          name: budgetName,
        },
      ],
    ],
    [
      'partial remote identity',
      [{ source: 'remote', cloudFileId: 'cloud-a', name: budgetName }],
    ],
    [
      'multiple local rows for one remote budget',
      [
        {
          source: 'local',
          id: 'local-a',
          cloudFileId: 'cloud-a',
          groupId: 'group-a',
          name: budgetName,
        },
        {
          source: 'local',
          id: 'local-b',
          cloudFileId: 'cloud-a',
          groupId: 'group-a',
          name: budgetName,
        },
      ],
    ],
    [
      'multiple remote rows for one remote budget',
      [
        {
          source: 'remote',
          cloudFileId: 'cloud-a',
          groupId: 'group-a',
          name: budgetName,
        },
        {
          source: 'remote',
          cloudFileId: 'cloud-a',
          groupId: 'group-a',
          name: budgetName,
        },
      ],
    ],
    [
      'local id on a remote row',
      [
        {
          source: 'remote',
          id: 'local-a',
          cloudFileId: 'cloud-a',
          groupId: 'group-a',
          name: budgetName,
        },
      ],
    ],
    ['missing local id', [{ source: 'local', name: budgetName }]],
  ])('rejects %s', (_label, representations) => {
    expect(() =>
      collapseActualBudgetRepresentations(
        representations as Parameters<
          typeof collapseActualBudgetRepresentations
        >[0],
      ),
    ).toThrow(ActualBudgetRepresentationError);
  });

  it('preserves a remote-only budget available for download', () => {
    expect(
      collapseActualBudgetRepresentations([
        {
          source: 'remote',
          cloudFileId: 'cloud-id',
          groupId: 'group-id',
          name: budgetName,
        },
      ]),
    ).toEqual([
      {
        cloudFileId: 'cloud-id',
        groupId: 'group-id',
        name: budgetName,
        localRepresentationPresent: false,
        remoteRepresentationPresent: true,
      },
    ]);
  });

  it('preserves an identified local-only budget as incomplete', () => {
    const [local] = collapseActualBudgetRepresentations([
      { source: 'local', id: 'local-id', name: budgetName },
    ]);

    expect(local).toMatchObject({
      localRepresentationPresent: true,
      remoteRepresentationPresent: false,
    });
    expect(actualBudgetIdentityKey(local!)).toBe(
      JSON.stringify(['local', 'local-id']),
    );
  });

  it('finds surviving identities across renamed local and remote rows', () => {
    const [target] = collapseActualBudgetRepresentations([
      {
        source: 'local',
        id: 'local-id',
        cloudFileId: 'cloud-id',
        groupId: 'group-id',
        name: budgetName,
      },
      {
        source: 'remote',
        cloudFileId: 'cloud-id',
        groupId: 'group-id',
        name: budgetName,
      },
    ]);

    expect(
      actualBudgetIdentityAppearsInRepresentations(
        [
          {
            source: 'remote',
            cloudFileId: 'cloud-id',
            groupId: 'group-id',
            name: 'Renamed budget',
          },
        ],
        target!,
      ),
    ).toBe(true);
    expect(actualBudgetIdentityAppearsInRepresentations([], target!)).toBe(
      false,
    );
  });

  it('refuses deletion confirmation from a malformed unrelated listing', () => {
    const [target] = collapseActualBudgetRepresentations([
      {
        source: 'remote',
        cloudFileId: 'cloud-id',
        groupId: 'group-id',
        name: budgetName,
      },
    ]);

    expect(() =>
      actualBudgetIdentityAppearsInRepresentations(
        [
          {
            source: 'local',
            cloudFileId: 'other-cloud',
            groupId: 'other-group',
            name: 'Malformed local row',
          },
        ],
        target!,
      ),
    ).toThrow(ActualBudgetRepresentationError);
  });
});
