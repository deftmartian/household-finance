class CategoryProvisioningStoppedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProvisioningStoppedError';
  }
}

const defaultIncomeConvergence = Object.freeze({
  sourceName: 'Income',
  targetAlias: 'income',
  targetName: 'Household Income',
  groupName: 'Income',
});

const householdCategoryConvergences = Object.freeze([
  Object.freeze({
    targetAlias: 'everyday-shopping',
    targetName: 'Everyday Shopping',
    sourceNames: Object.freeze([
      'General Merchandise',
      'Household Essentials',
      'Clothing & Personal',
    ]),
    groupName: 'Expense',
  }),
  Object.freeze({
    targetAlias: 'mortgage',
    targetName: 'Mortgage',
    sourceNames: Object.freeze(['Housing']),
    groupName: 'Expense',
  }),
  Object.freeze({
    targetAlias: 'trips',
    targetName: 'Trips',
    sourceNames: Object.freeze(['Travel']),
    groupName: 'Expense',
  }),
  Object.freeze({
    targetAlias: 'entertainment-hobbies',
    targetName: 'Entertainment & Hobbies',
    sourceNames: Object.freeze(['Entertainment']),
    groupName: 'Expense',
  }),
  Object.freeze({
    targetAlias: 'health-care',
    targetName: 'Health Care',
    sourceNames: Object.freeze(['Health']),
    groupName: 'Expense',
  }),
]);

function plannedDefaultIncomeTarget(plan) {
  const related = plan.categories.filter(
    (category) =>
      category.alias === defaultIncomeConvergence.targetAlias ||
      category.name === defaultIncomeConvergence.targetName,
  );
  if (related.length === 0) {
    return null;
  }
  const target = related[0];
  if (
    related.length !== 1 ||
    target.alias !== defaultIncomeConvergence.targetAlias ||
    target.name !== defaultIncomeConvergence.targetName ||
    target.kind !== 'income' ||
    plan.incomeGroupName !== defaultIncomeConvergence.groupName ||
    plan.categories.some(
      (category) => category.name === defaultIncomeConvergence.sourceName,
    )
  ) {
    throw new CategoryProvisioningStoppedError(
      'Default Income convergence requires the exact Household Income plan',
    );
  }
  return target;
}

function plannedHouseholdCategoryConvergences(plan) {
  return householdCategoryConvergences.flatMap((convergence) => {
    const related = plan.categories.filter(
      (category) =>
        category.alias === convergence.targetAlias ||
        category.name === convergence.targetName ||
        convergence.sourceNames.includes(category.name),
    );
    if (related.length === 0) {
      return [];
    }
    const target = related[0];
    if (
      related.length !== 1 ||
      target.alias !== convergence.targetAlias ||
      target.name !== convergence.targetName ||
      target.kind !== 'expense' ||
      plan.expenseGroupName !== convergence.groupName
    ) {
      throw new CategoryProvisioningStoppedError(
        `${convergence.targetName} convergence requires the exact current household category plan`,
      );
    }
    return [{ ...convergence, target }];
  });
}

function optionalExactNamed(records, name, label) {
  const matches = records.filter((record) => record.name === name);
  if (matches.length > 1) {
    throw new CategoryProvisioningStoppedError(
      `${label} is ambiguous; refusing convergence`,
    );
  }
  return matches[0] ?? null;
}

function inspectDefaultIncomeConvergence(categories, groups, plannedTarget) {
  const categoryRecords = categories.filter(
    (category) => typeof category.group_id === 'string',
  );
  const source = optionalExactNamed(
    categoryRecords,
    defaultIncomeConvergence.sourceName,
    'Default Income category',
  );
  if (source === null) {
    return { source: null };
  }
  const incomeGroup = optionalExactNamed(
    groups,
    defaultIncomeConvergence.groupName,
    'Default Income category group',
  );
  const target = optionalExactNamed(
    categoryRecords,
    plannedTarget.name,
    'Household Income category',
  );
  if (
    incomeGroup === null ||
    incomeGroup.is_income !== true ||
    incomeGroup.hidden !== false ||
    source.group_id !== incomeGroup.id ||
    source.is_income !== true ||
    source.hidden !== false ||
    (target !== null &&
      (target.group_id !== incomeGroup.id ||
        target.is_income !== true ||
        target.hidden !== false ||
        target.id === source.id))
  ) {
    throw new CategoryProvisioningStoppedError(
      'Default Income convergence state is incompatible; refusing convergence',
    );
  }
  return { source, target };
}

async function inspectLiveDefaultIncomeConvergence(api, plannedTarget) {
  const [categories, groups] = await Promise.all([
    api.getCategories(),
    api.getCategoryGroups(),
  ]);
  return inspectDefaultIncomeConvergence(categories, groups, plannedTarget);
}

function inspectHouseholdCategoryConvergence(categories, groups, convergence) {
  const categoryRecords = categories.filter(
    (category) => typeof category.group_id === 'string',
  );
  const target = optionalExactNamed(
    categoryRecords,
    convergence.targetName,
    `${convergence.targetName} category`,
  );
  const sources = convergence.sourceNames
    .map((sourceName) =>
      optionalExactNamed(
        categoryRecords,
        sourceName,
        `${sourceName} predecessor category`,
      ),
    )
    .filter((source) => source !== null);
  if (target === null && sources.length === 0) {
    return { target: null, sources: [] };
  }
  const group = optionalExactNamed(
    groups,
    convergence.groupName,
    `${convergence.groupName} category group`,
  );
  const related = [...(target === null ? [] : [target]), ...sources];
  if (
    group === null ||
    group.is_income !== false ||
    group.hidden !== false ||
    related.some(
      (category) =>
        category.group_id !== group.id ||
        category.is_income !== false ||
        category.hidden !== false,
    ) ||
    new Set(related.map((category) => category.id)).size !== related.length
  ) {
    throw new CategoryProvisioningStoppedError(
      `${convergence.targetName} convergence state is incompatible; refusing convergence`,
    );
  }
  return { target, sources };
}

async function inspectLiveHouseholdCategoryConvergence(api, convergence) {
  const [categories, groups] = await Promise.all([
    api.getCategories(),
    api.getCategoryGroups(),
  ]);
  return inspectHouseholdCategoryConvergence(categories, groups, convergence);
}

async function convergeHouseholdCategories(api, convergences, apply) {
  const inspected = [];
  for (const convergence of convergences) {
    inspected.push({
      convergence,
      state: await inspectLiveHouseholdCategoryConvergence(api, convergence),
    });
  }
  if (inspected.some(({ state }) => state.sources.length > 0) && !apply) {
    throw new CategoryProvisioningStoppedError(
      'Household categories require predecessor convergence',
    );
  }

  for (const { convergence, state } of inspected) {
    if (state.sources.length === 0) {
      continue;
    }
    let target = state.target;
    let sources = [...state.sources];
    if (target === null) {
      const survivor = sources.shift();
      if (survivor === undefined) {
        throw new CategoryProvisioningStoppedError(
          `${convergence.targetName} convergence lost its predecessor`,
        );
      }
      await api.updateCategory(survivor.id, {
        name: convergence.targetName,
      });
      await api.sync();
      const renamed = await inspectLiveHouseholdCategoryConvergence(
        api,
        convergence,
      );
      if (renamed.target === null || renamed.target.id !== survivor.id) {
        throw new CategoryProvisioningStoppedError(
          `${convergence.targetName} category rename failed readback`,
        );
      }
      target = renamed.target;
      sources = renamed.sources;
    }
    for (const source of sources) {
      await api.deleteCategory(source.id, target.id);
      await api.sync();
    }
    const readback = await inspectLiveHouseholdCategoryConvergence(
      api,
      convergence,
    );
    if (
      readback.target === null ||
      readback.target.id !== target.id ||
      readback.sources.length !== 0
    ) {
      throw new CategoryProvisioningStoppedError(
        `${convergence.targetName} convergence failed readback`,
      );
    }
  }
}

function exactPlannedCategory(categories, planned, expectedGroupId, groupName) {
  const named = categories.filter(
    (candidate) =>
      typeof candidate.group_id === 'string' && candidate.name === planned.name,
  );
  if (named.length !== 1) {
    throw new CategoryProvisioningStoppedError(
      `category ${planned.name} must resolve to exactly one live Actual identity`,
    );
  }
  const category = named[0];
  const isIncome = planned.kind === 'income';
  if (
    category.is_income !== isIncome ||
    category.hidden !== false ||
    category.group_id !== expectedGroupId
  ) {
    throw new CategoryProvisioningStoppedError(
      `Existing category ${planned.name} is not in the planned ${groupName} group`,
    );
  }
  return category;
}

async function ensureCategoryGroup(api, name, isIncome, apply) {
  const groups = await api.getCategoryGroups();
  const named = groups.filter((group) => group.name === name);
  if (named.length === 1) {
    const group = named[0];
    if (group.is_income !== isIncome || group.hidden !== false) {
      throw new CategoryProvisioningStoppedError(
        `Existing category group ${name} has incompatible properties`,
      );
    }
    return group.id;
  }
  if (named.length > 1 || !apply) {
    throw new CategoryProvisioningStoppedError(
      `Category group ${name} is missing or ambiguous`,
    );
  }
  const id = await api.createCategoryGroup({
    name,
    is_income: isIncome,
    hidden: false,
  });
  await api.sync();
  return id;
}

export async function ensureCategories(api, plan, apply) {
  const plannedIncomeTarget = plannedDefaultIncomeTarget(plan);
  if (plannedIncomeTarget !== null) {
    await inspectLiveDefaultIncomeConvergence(api, plannedIncomeTarget);
  }
  const plannedHouseholdConvergences =
    plannedHouseholdCategoryConvergences(plan);
  await convergeHouseholdCategories(api, plannedHouseholdConvergences, apply);

  let expenseGroupId;
  let incomeGroupId;
  const identities = {};
  for (const planned of plan.categories) {
    const isIncome = planned.kind === 'income';
    const groupName = isIncome ? plan.incomeGroupName : plan.expenseGroupName;
    let categories = await api.getCategories();
    const categoryAlreadyExists = categories.some(
      (candidate) =>
        typeof candidate.group_id === 'string' &&
        candidate.name === planned.name,
    );
    if (isIncome) {
      incomeGroupId ??= await ensureCategoryGroup(
        api,
        groupName,
        true,
        apply && !categoryAlreadyExists,
      );
    } else {
      expenseGroupId ??= await ensureCategoryGroup(
        api,
        groupName,
        false,
        apply && !categoryAlreadyExists,
      );
    }
    const expectedGroupId = isIncome ? incomeGroupId : expenseGroupId;
    if (!categoryAlreadyExists && apply) {
      await api.createCategory({
        name: planned.name,
        group_id: expectedGroupId,
        is_income: isIncome,
        hidden: false,
      });
      await api.sync();
      categories = await api.getCategories();
    }
    const category = exactPlannedCategory(
      categories,
      planned,
      expectedGroupId,
      groupName,
    );
    identities[planned.alias] = {
      id: category.id,
      name: category.name,
      kind: planned.kind,
      modelSelectable: planned.modelSelectable,
      writerEnabled: planned.writerEnabled,
    };
  }

  if (plannedIncomeTarget !== null) {
    const convergence = await inspectLiveDefaultIncomeConvergence(
      api,
      plannedIncomeTarget,
    );
    if (convergence.source !== null) {
      if (!apply) {
        throw new CategoryProvisioningStoppedError(
          'Default Income category requires convergence into Household Income',
        );
      }
      const target = convergence.target;
      const plannedIdentity = identities[plannedIncomeTarget.alias];
      if (
        target === null ||
        plannedIdentity === undefined ||
        target.id !== plannedIdentity.id
      ) {
        throw new CategoryProvisioningStoppedError(
          'Household Income category changed before convergence',
        );
      }
      await api.deleteCategory(convergence.source.id, target.id);
      await api.sync();

      const readback = await inspectLiveDefaultIncomeConvergence(
        api,
        plannedIncomeTarget,
      );
      if (readback.source !== null) {
        throw new CategoryProvisioningStoppedError(
          'Default Income category convergence failed readback',
        );
      }
      const verifiedTarget = exactPlannedCategory(
        await api.getCategories(),
        plannedIncomeTarget,
        incomeGroupId,
        plan.incomeGroupName,
      );
      if (verifiedTarget.id !== target.id) {
        throw new CategoryProvisioningStoppedError(
          'Household Income category changed during convergence',
        );
      }
    }
  }
  return identities;
}
