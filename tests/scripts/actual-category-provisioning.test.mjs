import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { ensureCategories } from '../../scripts/actual-category-provisioning.mjs';

const canonicalCategoryPlan = JSON.parse(
  readFileSync(
    new URL(
      '../../config/default-household-category-plan.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const plan = {
  expenseGroupName: 'Expense',
  incomeGroupName: 'Income',
  categories: [
    {
      alias: 'groceries',
      name: 'Groceries',
      kind: 'expense',
      modelSelectable: true,
      writerEnabled: true,
    },
  ],
};

const incomePlan = {
  expenseGroupName: 'Expense',
  incomeGroupName: 'Income',
  categories: [
    {
      alias: 'income',
      name: 'Household Income',
      kind: 'income',
      modelSelectable: true,
      writerEnabled: true,
    },
  ],
};

const householdConvergenceTargets = new Map([
  ['everyday-shopping', 'Everyday Shopping'],
  ['mortgage', 'Mortgage'],
  ['trips', 'Trips'],
  ['entertainment-hobbies', 'Entertainment & Hobbies'],
  ['health-care', 'Health Care'],
]);
const householdConvergenceSourceNames = [
  'General Merchandise',
  'Household Essentials',
  'Clothing & Personal',
  'Housing',
  'Travel',
  'Entertainment',
  'Health',
];
const householdPlan = {
  expenseGroupName: canonicalCategoryPlan.expenseGroupName,
  incomeGroupName: canonicalCategoryPlan.incomeGroupName,
  categories: canonicalCategoryPlan.categories.filter((category) =>
    householdConvergenceTargets.has(category.alias),
  ),
};

const categoryGroups = [
  { id: 'expense-group', name: 'Expense', is_income: false, hidden: false },
  { id: 'income-group', name: 'Income', is_income: true, hidden: false },
];

function incomeCategory(name, id, override = {}) {
  return {
    id,
    name,
    group_id: 'income-group',
    is_income: true,
    hidden: false,
    ...override,
  };
}

function expenseCategory(name, id, override = {}) {
  return {
    id,
    name,
    group_id: 'expense-group',
    is_income: false,
    hidden: false,
    ...override,
  };
}

function legacyHouseholdCategories() {
  return [
    expenseCategory('General Merchandise', 'general-merchandise-category'),
    expenseCategory('Household Essentials', 'household-essentials-category'),
    expenseCategory('Clothing & Personal', 'clothing-personal-category'),
    expenseCategory('Housing', 'housing-category'),
    expenseCategory('Travel', 'travel-category'),
    expenseCategory('Entertainment', 'entertainment-category'),
    expenseCategory('Health', 'health-category'),
  ];
}

function currentHouseholdCategories() {
  return [
    expenseCategory('Everyday Shopping', 'general-merchandise-category'),
    expenseCategory('Mortgage', 'housing-category'),
    expenseCategory('Trips', 'travel-category'),
    expenseCategory('Entertainment & Hobbies', 'entertainment-category'),
    expenseCategory('Health Care', 'health-category'),
  ];
}

function convergableIncomeCategories() {
  return [
    incomeCategory('Income', 'default-income-category'),
    incomeCategory('Household Income', 'household-income-category'),
  ];
}

function actualApi(categories, groups = categoryGroups) {
  const liveCategories = categories.map((category) => ({ ...category }));
  return {
    getCategoryGroups: vi.fn(async () => groups.map((group) => ({ ...group }))),
    getCategories: vi.fn(async () =>
      liveCategories.map((category) => ({ ...category })),
    ),
    createCategoryGroup: vi.fn(),
    createCategory: vi.fn(async (category) => {
      liveCategories.push({ id: 'created-category', ...category });
      return 'created-category';
    }),
    updateCategory: vi.fn(async (id, fields) => {
      const category = liveCategories.find((candidate) => candidate.id === id);
      if (
        category === undefined ||
        (fields.name !== undefined &&
          liveCategories.some(
            (candidate) =>
              candidate.id !== id && candidate.name === fields.name,
          ))
      ) {
        throw new Error('invalid category rename fixture');
      }
      Object.assign(category, fields);
    }),
    deleteCategory: vi.fn(async (sourceId, targetId) => {
      const sourceIndex = liveCategories.findIndex(
        (category) => category.id === sourceId,
      );
      if (
        sourceIndex === -1 ||
        !liveCategories.some((category) => category.id === targetId)
      ) {
        throw new Error('invalid category convergence fixture');
      }
      liveCategories.splice(sourceIndex, 1);
    }),
    sync: vi.fn(),
  };
}

describe('Actual category provisioning', () => {
  it('keeps bounded household convergence names aligned with the canonical plan', () => {
    expect(
      new Map(
        householdPlan.categories.map((category) => [
          category.alias,
          category.name,
        ]),
      ),
    ).toEqual(householdConvergenceTargets);
    expect(
      canonicalCategoryPlan.categories
        .map((category) => category.name)
        .filter((name) => householdConvergenceSourceNames.includes(name)),
    ).toEqual([]);
  });

  it('accepts the exact live category in its planned group', async () => {
    const api = actualApi([
      {
        id: 'groceries-category',
        name: 'Groceries',
        group_id: 'expense-group',
        is_income: false,
        hidden: false,
      },
    ]);

    await expect(ensureCategories(api, plan, true)).resolves.toEqual({
      groceries: {
        id: 'groceries-category',
        name: 'Groceries',
        kind: 'expense',
        modelSelectable: true,
        writerEnabled: true,
      },
    });
    expect(api.createCategoryGroup).not.toHaveBeenCalled();
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
  });

  it('rejects an existing category in the wrong group without mutating Actual', async () => {
    const api = actualApi([
      {
        id: 'groceries-category',
        name: 'Groceries',
        group_id: 'wrong-expense-group',
        is_income: false,
        hidden: false,
      },
    ]);

    await expect(ensureCategories(api, plan, true)).rejects.toThrow(
      'Existing category Groceries is not in the planned Expense group',
    );
    expect(api.createCategoryGroup).not.toHaveBeenCalled();
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
  });

  it('creates a missing category once in the planned group and is safe to rerun', async () => {
    const api = actualApi([]);

    await expect(ensureCategories(api, plan, true)).resolves.toMatchObject({
      groceries: { id: 'created-category', name: 'Groceries' },
    });
    await expect(ensureCategories(api, plan, true)).resolves.toMatchObject({
      groceries: { id: 'created-category', name: 'Groceries' },
    });
    expect(api.createCategory).toHaveBeenCalledTimes(1);
    expect(api.createCategory).toHaveBeenCalledWith({
      name: 'Groceries',
      group_id: 'expense-group',
      is_income: false,
      hidden: false,
    });
    expect(api.sync).toHaveBeenCalledTimes(1);
  });

  it('renames and merges the exact legacy household categories without losing their identities', async () => {
    const api = actualApi(legacyHouseholdCategories());

    await expect(ensureCategories(api, householdPlan, true)).resolves.toEqual({
      'everyday-shopping': {
        id: 'general-merchandise-category',
        name: 'Everyday Shopping',
        kind: 'expense',
        modelSelectable: true,
        writerEnabled: true,
      },
      mortgage: {
        id: 'housing-category',
        name: 'Mortgage',
        kind: 'expense',
        modelSelectable: true,
        writerEnabled: true,
      },
      trips: {
        id: 'travel-category',
        name: 'Trips',
        kind: 'expense',
        modelSelectable: true,
        writerEnabled: true,
      },
      'entertainment-hobbies': {
        id: 'entertainment-category',
        name: 'Entertainment & Hobbies',
        kind: 'expense',
        modelSelectable: true,
        writerEnabled: true,
      },
      'health-care': {
        id: 'health-category',
        name: 'Health Care',
        kind: 'expense',
        modelSelectable: true,
        writerEnabled: true,
      },
    });
    expect(api.updateCategory.mock.calls).toEqual([
      ['general-merchandise-category', { name: 'Everyday Shopping' }],
      ['housing-category', { name: 'Mortgage' }],
      ['travel-category', { name: 'Trips' }],
      ['entertainment-category', { name: 'Entertainment & Hobbies' }],
      ['health-category', { name: 'Health Care' }],
    ]);
    expect(api.deleteCategory.mock.calls).toEqual([
      ['household-essentials-category', 'general-merchandise-category'],
      ['clothing-personal-category', 'general-merchandise-category'],
    ]);
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.sync).toHaveBeenCalledTimes(7);
  });

  it('does not repeat a completed household category convergence', async () => {
    const api = actualApi(legacyHouseholdCategories());

    await ensureCategories(api, householdPlan, true);
    await ensureCategories(api, householdPlan, true);

    expect(api.updateCategory).toHaveBeenCalledTimes(5);
    expect(api.deleteCategory).toHaveBeenCalledTimes(2);
    expect(api.sync).toHaveBeenCalledTimes(7);
  });

  it('finishes a supported partial household category convergence', async () => {
    const api = actualApi([
      ...currentHouseholdCategories(),
      expenseCategory('Household Essentials', 'household-essentials-category'),
    ]);

    await expect(
      ensureCategories(api, householdPlan, true),
    ).resolves.toMatchObject({
      'everyday-shopping': { id: 'general-merchandise-category' },
    });
    expect(api.updateCategory).not.toHaveBeenCalled();
    expect(api.deleteCategory).toHaveBeenCalledWith(
      'household-essentials-category',
      'general-merchandise-category',
    );
    expect(api.sync).toHaveBeenCalledOnce();
  });

  it('refuses a required household convergence in inspect mode without mutation', async () => {
    const api = actualApi(legacyHouseholdCategories());

    await expect(ensureCategories(api, householdPlan, false)).rejects.toThrow(
      'Household categories require predecessor convergence',
    );
    expect(api.updateCategory).not.toHaveBeenCalled();
    expect(api.deleteCategory).not.toHaveBeenCalled();
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
  });

  it('rejects ambiguous household predecessors without mutation', async () => {
    const api = actualApi([
      ...legacyHouseholdCategories(),
      expenseCategory(
        'Household Essentials',
        'duplicate-household-essentials-category',
      ),
    ]);

    await expect(ensureCategories(api, householdPlan, true)).rejects.toThrow(
      'Household Essentials predecessor category is ambiguous; refusing convergence',
    );
    expect(api.updateCategory).not.toHaveBeenCalled();
    expect(api.deleteCategory).not.toHaveBeenCalled();
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong type', { is_income: true }],
    ['hidden', { hidden: true }],
    ['wrong group', { group_id: 'wrong-expense-group' }],
  ])(
    'rejects an incompatible household predecessor (%s) without mutation',
    async (_label, override) => {
      const categories = legacyHouseholdCategories();
      categories[0] = expenseCategory(
        'General Merchandise',
        'general-merchandise-category',
        override,
      );
      const api = actualApi(categories);

      await expect(ensureCategories(api, householdPlan, true)).rejects.toThrow(
        'Everyday Shopping convergence state is incompatible; refusing convergence',
      );
      expect(api.updateCategory).not.toHaveBeenCalled();
      expect(api.deleteCategory).not.toHaveBeenCalled();
      expect(api.createCategory).not.toHaveBeenCalled();
      expect(api.sync).not.toHaveBeenCalled();
    },
  );

  it('requires the exact current household category plan before convergence', async () => {
    const api = actualApi(legacyHouseholdCategories());
    const legacyPlan = {
      ...householdPlan,
      categories: [
        {
          alias: 'general-merchandise',
          name: 'General Merchandise',
          kind: 'expense',
          modelSelectable: true,
          writerEnabled: true,
        },
      ],
    };

    await expect(ensureCategories(api, legacyPlan, true)).rejects.toThrow(
      'Everyday Shopping convergence requires the exact current household category plan',
    );
    expect(api.updateCategory).not.toHaveBeenCalled();
    expect(api.deleteCategory).not.toHaveBeenCalled();
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
  });

  it('merges the exact Actual default Income category into Household Income', async () => {
    const api = actualApi(convergableIncomeCategories());

    await expect(ensureCategories(api, incomePlan, true)).resolves.toEqual({
      income: {
        id: 'household-income-category',
        name: 'Household Income',
        kind: 'income',
        modelSelectable: true,
        writerEnabled: true,
      },
    });
    expect(api.deleteCategory).toHaveBeenCalledOnce();
    expect(api.deleteCategory).toHaveBeenCalledWith(
      'default-income-category',
      'household-income-category',
    );
    expect(api.sync).toHaveBeenCalledOnce();
  });

  it('creates a missing Household Income target before convergence', async () => {
    const api = actualApi([
      incomeCategory('Income', 'default-income-category'),
    ]);

    await expect(
      ensureCategories(api, incomePlan, true),
    ).resolves.toMatchObject({
      income: { id: 'created-category', name: 'Household Income' },
    });
    expect(api.createCategory).toHaveBeenCalledOnce();
    expect(api.deleteCategory).toHaveBeenCalledWith(
      'default-income-category',
      'created-category',
    );
    expect(api.sync).toHaveBeenCalledTimes(2);
  });

  it('does not repeat a completed default Income convergence', async () => {
    const api = actualApi(convergableIncomeCategories());

    await ensureCategories(api, incomePlan, true);
    await ensureCategories(api, incomePlan, true);

    expect(api.deleteCategory).toHaveBeenCalledOnce();
    expect(api.sync).toHaveBeenCalledOnce();
  });

  it('rejects ambiguous default Income predecessors without mutation', async () => {
    const api = actualApi([
      incomeCategory('Income', 'default-income-category-a'),
      incomeCategory('Income', 'default-income-category-b', {
        group_id: 'wrong-income-group',
      }),
    ]);

    await expect(ensureCategories(api, incomePlan, true)).rejects.toThrow(
      'Default Income category is ambiguous; refusing convergence',
    );
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.deleteCategory).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong type', { is_income: false }],
    ['hidden', { hidden: true }],
    ['wrong group', { group_id: 'wrong-income-group' }],
  ])(
    'rejects an incompatible default Income predecessor (%s) without mutation',
    async (_label, override) => {
      const api = actualApi([
        incomeCategory('Income', 'default-income-category', override),
      ]);

      await expect(ensureCategories(api, incomePlan, true)).rejects.toThrow(
        'Default Income convergence state is incompatible; refusing convergence',
      );
      expect(api.createCategory).not.toHaveBeenCalled();
      expect(api.deleteCategory).not.toHaveBeenCalled();
      expect(api.sync).not.toHaveBeenCalled();
    },
  );

  it('rejects an incompatible Household Income target without mutation', async () => {
    const api = actualApi([
      incomeCategory('Income', 'default-income-category'),
      incomeCategory('Household Income', 'household-income-category', {
        group_id: 'expense-group',
        is_income: false,
      }),
    ]);

    await expect(ensureCategories(api, incomePlan, true)).rejects.toThrow(
      'Default Income convergence state is incompatible; refusing convergence',
    );
    expect(api.createCategory).not.toHaveBeenCalled();
    expect(api.deleteCategory).not.toHaveBeenCalled();
    expect(api.sync).not.toHaveBeenCalled();
  });
});
