import {
  receiptModelProposalV1Schema,
  type ReceiptModelProposalV1,
} from './proposal.js';

export type ReceiptModelProposalIssueCode =
  | 'amounts-incomplete'
  | 'amounts-invalid'
  | 'currency-missing'
  | 'date-missing'
  | 'document-not-single-receipt'
  | 'line-items-incomplete'
  | 'line-items-mismatch'
  | 'material-model-uncertainty'
  | 'merchant-missing'
  | 'total-missing';

export interface ReceiptModelProposalAssessment {
  disposition: 'ready' | 'review';
  materialAmbiguity: boolean;
  arithmeticChecked: boolean;
  arithmeticCorrect: boolean;
  issueCodes: ReceiptModelProposalIssueCode[];
}

const NON_BLOCKING_UNCERTAINTY_CODES = new Set<
  ReceiptModelProposalV1['uncertainties'][number]['code']
>(['currency-unclear', 'merchant-unclear', 'payment-unclear']);

function optionalAmountMinorForArithmetic(
  field: ReceiptModelProposalV1['amounts']['tax'],
): number | null {
  if (field.valueMinor !== null) {
    return field.valueMinor;
  }
  return field.evidence === 'absent' && field.sourcePage === null ? 0 : null;
}

function supportedLineItemTotals(
  subtotalMinor: number | null,
  taxMinor: number | null,
  tipMinor: number | null,
  discountMinor: number | null,
  totalMinor: number | null,
): ReadonlySet<number> {
  const totals = [subtotalMinor, totalMinor].filter(
    (value): value is number => value !== null,
  );
  // Warehouse receipts commonly print merchandise rows before a voucher or
  // instant-savings adjustment, while the subtotal is already net of it.
  // Those complete rows are still a sound basis for proportionally allocating
  // the final receipt total across categories.
  const conventionalSubtotalReconciles =
    subtotalMinor !== null &&
    taxMinor !== null &&
    tipMinor !== null &&
    discountMinor !== null &&
    totalMinor !== null &&
    subtotalMinor + taxMinor + tipMinor - discountMinor === totalMinor;
  const netSubtotalReconciles =
    subtotalMinor !== null &&
    taxMinor !== null &&
    tipMinor !== null &&
    totalMinor !== null &&
    subtotalMinor + taxMinor + tipMinor === totalMinor;
  if (
    subtotalMinor !== null &&
    discountMinor !== null &&
    discountMinor > 0 &&
    netSubtotalReconciles &&
    !conventionalSubtotalReconciles
  ) {
    totals.push(subtotalMinor + discountMinor);
  }
  return new Set(totals);
}

export function receiptLineItemsSupportAllocation(
  untrustedReceipt: ReceiptModelProposalV1,
): boolean {
  const receipt = receiptModelProposalV1Schema.parse(untrustedReceipt);
  if (
    receipt.lineItems.length === 0 ||
    receipt.uncertainties.some(
      (uncertainty) =>
        uncertainty.material && uncertainty.code === 'line-items-unclear',
    )
  ) {
    return false;
  }
  let lineItemTotal = 0;
  for (const item of receipt.lineItems) {
    if (item.totalMinor === null) {
      return false;
    }
    lineItemTotal += item.totalMinor;
  }
  return supportedLineItemTotals(
    receipt.amounts.subtotal.valueMinor,
    optionalAmountMinorForArithmetic(receipt.amounts.tax),
    optionalAmountMinorForArithmetic(receipt.amounts.tip),
    receipt.amounts.discount.valueMinor,
    receipt.amounts.total.valueMinor,
  ).has(lineItemTotal);
}

export function assessReceiptModelProposal(
  untrustedProposal: unknown,
): ReceiptModelProposalAssessment {
  const proposal: ReceiptModelProposalV1 =
    receiptModelProposalV1Schema.parse(untrustedProposal);
  const issues = new Set<ReceiptModelProposalIssueCode>();

  if (proposal.documentDisposition !== 'single-receipt') {
    issues.add('document-not-single-receipt');
  }
  if (proposal.merchant.value === null) {
    issues.add('merchant-missing');
  }
  if (proposal.purchaseDate.value === null) {
    issues.add('date-missing');
  }
  if (proposal.currency.value === null) {
    issues.add('currency-missing');
  }
  if (proposal.amounts.total.valueMinor === null) {
    issues.add('total-missing');
  }
  if (
    proposal.uncertainties.some(
      (uncertainty) =>
        uncertainty.material &&
        !NON_BLOCKING_UNCERTAINTY_CODES.has(uncertainty.code),
    )
  ) {
    issues.add('material-model-uncertainty');
  }

  const subtotalMinor = proposal.amounts.subtotal.valueMinor;
  const taxMinor = optionalAmountMinorForArithmetic(proposal.amounts.tax);
  const discountMinor = optionalAmountMinorForArithmetic(
    proposal.amounts.discount,
  );
  const tipMinor = optionalAmountMinorForArithmetic(proposal.amounts.tip);
  const totalMinor = proposal.amounts.total.valueMinor;
  const candidateArithmeticChecked =
    subtotalMinor !== null &&
    taxMinor !== null &&
    discountMinor !== null &&
    tipMinor !== null &&
    totalMinor !== null;
  const completeLineItemTotal = proposal.lineItems.every(
    (item) => item.totalMinor !== null,
  )
    ? proposal.lineItems.reduce((sum, item) => sum + (item.totalMinor ?? 0), 0)
    : null;
  const candidateArithmeticCorrect = candidateArithmeticChecked
    ? subtotalMinor + taxMinor + tipMinor - discountMinor === totalMinor ||
      (discountMinor > 0 &&
        completeLineItemTotal === subtotalMinor + discountMinor &&
        subtotalMinor + taxMinor + tipMinor === totalMinor)
    : false;
  const assumedAbsentOptionalAmount = [
    proposal.amounts.tax,
    proposal.amounts.discount,
    proposal.amounts.tip,
  ].some((field) => field.valueMinor === null && field.evidence === 'absent');
  const arithmeticChecked =
    candidateArithmeticChecked &&
    (!assumedAbsentOptionalAmount || candidateArithmeticCorrect);
  const arithmeticCorrect = arithmeticChecked && candidateArithmeticCorrect;
  if (!arithmeticChecked) {
    issues.add('amounts-incomplete');
  } else if (!arithmeticCorrect) {
    issues.add('amounts-invalid');
  }

  if (proposal.lineItems.length === 0) {
    issues.add('line-items-incomplete');
  } else {
    let lineItemsComplete = true;
    let lineItemTotal = 0;
    for (const lineItem of proposal.lineItems) {
      if (lineItem.totalMinor === null) {
        lineItemsComplete = false;
      } else {
        lineItemTotal += lineItem.totalMinor;
      }
    }
    if (!lineItemsComplete) {
      issues.add('line-items-incomplete');
    } else {
      const expectedLineItemTotals = supportedLineItemTotals(
        proposal.amounts.subtotal.valueMinor,
        taxMinor,
        tipMinor,
        proposal.amounts.discount.valueMinor,
        proposal.amounts.total.valueMinor,
      );
      if (!expectedLineItemTotals.has(lineItemTotal)) {
        issues.add('line-items-mismatch');
      }
    }
  }

  const issueCodes = [...issues].sort();
  return {
    disposition: issueCodes.length === 0 ? 'ready' : 'review',
    materialAmbiguity: issueCodes.length > 0,
    arithmeticChecked,
    arithmeticCorrect,
    issueCodes,
  };
}
