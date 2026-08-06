const cadFormatter = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
});

function displayPercent(valueBasisPoints: number): string {
  return `${(valueBasisPoints / 100).toFixed(2)}%`;
}

function displayCurrency(currency: string, valueMinorUnits: number): string {
  return `${currency} ${(valueMinorUnits / 100).toFixed(2)}`;
}

/**
 * Converts validated read results into model-friendly exact facts. Integer
 * source values remain present beside display strings, so the model does not
 * need to calculate money or percentages.
 */
export function transformExactFacts(
  value: unknown,
  propertyName?: string,
): unknown {
  if (
    propertyName?.endsWith('MinorUnits') === true &&
    typeof value === 'number' &&
    Number.isSafeInteger(value)
  ) {
    return {
      minorUnits: value,
      displayCad: cadFormatter.format(value / 100),
    };
  }
  if (
    propertyName?.endsWith('BasisPoints') === true &&
    typeof value === 'number' &&
    Number.isSafeInteger(value)
  ) {
    return {
      basisPoints: value,
      displayPercent: displayPercent(value),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => transformExactFacts(entry));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        transformExactFacts(entry, key),
      ]),
    );
  }
  return value;
}

function transformReceiptEntry(
  value: unknown,
  propertyName?: string,
  inheritedCurrency?: string | null,
): unknown {
  if (
    propertyName?.endsWith('MinorUnits') === true &&
    typeof value === 'number' &&
    Number.isSafeInteger(value)
  ) {
    return inheritedCurrency === undefined
      ? transformExactFacts(value, propertyName)
      : {
          minorUnits: value,
          currency: inheritedCurrency,
          display:
            inheritedCurrency === null
              ? null
              : displayCurrency(inheritedCurrency, value),
        };
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      transformReceiptEntry(entry, undefined, inheritedCurrency),
    );
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const currency = Object.hasOwn(record, 'currency')
      ? typeof record.currency === 'string' || record.currency === null
        ? record.currency
        : inheritedCurrency
      : inheritedCurrency;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        transformReceiptEntry(entry, key, currency),
      ]),
    );
  }
  return transformExactFacts(value, propertyName);
}

/** Formats receipt money in the currency recorded on each receipt row. */
export function transformReceiptExactFacts(value: unknown): unknown {
  return transformReceiptEntry(value);
}
