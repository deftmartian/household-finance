import { describe, expect, it } from 'vitest';

import {
  buildActiveReceiptRecord,
  bundleReceiptPhotos,
  type ReceiptPhotoCandidate,
} from '../../src/receipts/photo-bundler.js';
import type { ReceiptModelProposalV1 } from '../../src/model/index.js';
import { receiptRecordItemDetailsComplete } from '../../src/receipt-record/index.js';

function field<T>(value: T | null, confidence = 0.9) {
  return {
    value,
    evidence: value === null ? ('absent' as const) : ('explicit' as const),
    confidence,
    sourcePage: value === null ? null : 1,
  };
}

function amount(valueMinor: number | null, confidence = 0.9) {
  return {
    valueMinor,
    evidence: valueMinor === null ? ('absent' as const) : ('explicit' as const),
    confidence,
    sourcePage: valueMinor === null ? null : 1,
  };
}

function proposal(input: {
  merchant?: string | null;
  date?: string | null;
  total?: number | null;
  reference?: string | null;
  items?: readonly [string, number][];
}): ReceiptModelProposalV1 {
  return {
    schemaVersion: 'receipt-model-proposal.v1',
    documentDisposition: 'single-receipt',
    merchant: field(input.merchant ?? null),
    purchaseDate: field(input.date ?? null),
    purchaseTime: field<string>(null),
    timezoneOffset: field<string>(null),
    currency: field('CAD'),
    amounts: {
      subtotal: amount(null),
      tax: amount(null),
      discount: amount(null),
      tip: amount(null),
      total: amount(input.total ?? null),
    },
    paymentEvidence: {
      kind: 'unknown',
      lastFour: null,
      confidence: 0,
      sourcePage: null,
    },
    receiptReference: field(input.reference ?? null),
    lineItems: (input.items ?? []).map(([description, totalMinor]) => ({
      description,
      quantity: 1,
      unitPriceMinor: totalMinor,
      totalMinor,
      confidence: 0.9,
      sourcePage: 1,
    })),
    uncertainties: [],
  };
}

function candidate(
  index: number,
  receipt: ReceiptModelProposalV1,
  receivedAt: string,
): ReceiptPhotoCandidate {
  return {
    eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    roomToken: 'household',
    actorId: 'alex',
    messageId: `message-${index}`,
    receivedAt,
    fileId: String(index),
    archivePath: `2026/07/receipt-${index}.jpg`,
    mediaType: 'image/jpeg',
    sourceSha256: String(index).padStart(64, '0'),
    extractedAt: new Date(Date.parse(receivedAt) + 1_000).toISOString(),
    modelMetadata: {
      provider: 'xai',
      requestedModel: 'grok-4.5',
      resolvedModel: 'grok-4.5',
      preflightAttempts: 1,
      documentAttempts: 1,
      durationMs: 1_000,
      zeroDataRetention: true,
    },
    receipt,
  };
}

function materialUncertainty(
  code: ReceiptModelProposalV1['uncertainties'][number]['code'],
  message = 'Synthetic page-local uncertainty',
): ReceiptModelProposalV1['uncertainties'][number] {
  return { code, message, material: true, sourcePage: 1 };
}

describe('bundleReceiptPhotos', () => {
  it('merges overlapping photos and retains the most complete facts', () => {
    const bundles = bundleReceiptPhotos([
      candidate(
        1,
        proposal({
          merchant: 'MEC',
          total: 85_42,
          items: [['Trail socks', 28_49]],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
      candidate(
        2,
        proposal({
          merchant: 'Mountain Equipment Company',
          date: '2026-07-12',
          total: 85_42,
          items: [
            ['Trail socks', 28_49],
            ['Water bottle', 28_44],
          ],
        }),
        '2026-07-29T12:06:00.000Z',
      ),
    ]);

    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.receiptId).toBe('00000000-0000-4000-8000-000000000001');
    expect(bundles[0]?.sources).toHaveLength(2);
    expect(bundles[0]?.receipt.purchaseDate.value).toBe('2026-07-12');
    expect(bundles[0]?.receipt.lineItems).toHaveLength(2);
  });

  it('reconciles stale page-local warnings after a complete multi-photo merge', () => {
    const top = proposal({
      merchant: 'Costco Wholesale',
      items: [
        ['Milk', 6_00],
        ['Bread', 4_00],
        ['Eggs', 5_00],
      ],
    });
    top.amounts = {
      subtotal: amount(null),
      tax: amount(null),
      discount: amount(null),
      tip: amount(null),
      total: amount(null),
    };
    top.uncertainties = [
      materialUncertainty('date-unclear'),
      materialUncertainty('amounts-unclear'),
    ];

    const bottom = proposal({
      date: '2026-08-12',
      total: 17_25,
      items: [
        ['Bread', 4_00],
        ['Eggs', 5_00],
        ['Dish soap', 3_00],
        ['123456 TPD/DISH SOAP', 3_00],
      ],
    });
    bottom.amounts = {
      subtotal: amount(15_00),
      tax: amount(2_25),
      discount: amount(3_00),
      tip: amount(0),
      total: amount(17_25),
    };
    bottom.uncertainties = [
      materialUncertainty('merchant-unclear'),
      materialUncertainty('line-items-unclear'),
    ];

    const bundle = bundleReceiptPhotos([
      candidate(1, top, '2026-08-12T20:00:00.000Z'),
      candidate(2, bottom, '2026-08-12T20:00:10.000Z'),
    ])[0]!;
    const record = buildActiveReceiptRecord(bundle);

    expect(bundle.sources).toHaveLength(2);
    expect(bundle.receipt.uncertainties).toEqual([
      materialUncertainty('merchant-unclear'),
    ]);
    expect(record.extraction).not.toHaveProperty('automaticProcessingBlocked');
    expect(record.extraction).not.toHaveProperty('itemSplitBlocked');
    expect(receiptRecordItemDetailsComplete(record)).toBe(true);
  });

  it('retains page-local warnings when the merged facts do not reconcile', () => {
    const top = proposal({
      merchant: 'Costco Wholesale',
      items: [
        ['Milk', 6_00],
        ['Bread', 4_00],
      ],
    });
    top.amounts = {
      subtotal: amount(10_00),
      tax: amount(1_50),
      discount: amount(0),
      tip: amount(0),
      total: amount(null),
    };
    top.uncertainties = [materialUncertainty('amounts-unclear')];

    const bottom = proposal({
      date: '2026-08-12',
      total: 12_00,
      items: [
        ['Milk', 6_00],
        ['Bread', 4_00],
        ['Unreadable item', 1_00],
      ],
    });
    bottom.amounts = {
      subtotal: amount(10_00),
      tax: amount(1_50),
      discount: amount(0),
      tip: amount(0),
      total: amount(12_00),
    };
    bottom.uncertainties = [materialUncertainty('line-items-unclear')];

    const bundle = bundleReceiptPhotos([
      candidate(1, top, '2026-08-12T20:00:00.000Z'),
      candidate(2, bottom, '2026-08-12T20:00:10.000Z'),
    ])[0]!;
    const record = buildActiveReceiptRecord(bundle);

    expect(bundle.receipt.uncertainties.map(({ code }) => code)).toEqual([
      'amounts-unclear',
      'line-items-unclear',
    ]);
    expect(record.extraction).toMatchObject({
      automaticProcessingBlocked: true,
      itemSplitBlocked: true,
    });
  });

  it('does not override a material warning reported by every source page', () => {
    const warned = proposal({
      merchant: 'Costco Wholesale',
      date: '2026-08-12',
      total: 11_50,
      items: [
        ['Milk', 6_00],
        ['Bread', 4_00],
      ],
    });
    warned.amounts = {
      subtotal: amount(10_00),
      tax: amount(1_50),
      discount: amount(0),
      tip: amount(0),
      total: amount(11_50),
    };
    warned.uncertainties = [materialUncertainty('amounts-unclear')];

    const bundle = bundleReceiptPhotos([
      candidate(1, warned, '2026-08-12T20:00:00.000Z'),
      candidate(2, warned, '2026-08-12T20:00:10.000Z'),
    ])[0]!;

    expect(bundle.receipt.uncertainties).toEqual([
      materialUncertainty('amounts-unclear'),
    ]);
    expect(buildActiveReceiptRecord(bundle).extraction).toMatchObject({
      automaticProcessingBlocked: true,
    });
  });

  it('does not merge distinct same-merchant receipts with different totals', () => {
    const bundles = bundleReceiptPhotos([
      candidate(
        1,
        proposal({
          merchant: 'Amazon',
          date: '2026-07-29',
          total: 19_99,
          items: [['Cable', 19_99]],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
      candidate(
        2,
        proposal({
          merchant: 'Amazon',
          date: '2026-07-29',
          total: 29_99,
          items: [['Adapter', 29_99]],
        }),
        '2026-07-29T12:01:00.000Z',
      ),
    ]);

    expect(bundles).toHaveLength(2);
  });

  it('does not merge contradictory receipts attached to the same Talk message', () => {
    const first = candidate(
      1,
      proposal({
        merchant: 'Amazon',
        date: '2026-07-29',
        total: 19_99,
        items: [['Cable', 19_99]],
      }),
      '2026-07-29T12:00:00.000Z',
    );
    const second = {
      ...candidate(
        2,
        proposal({
          merchant: 'Amazon',
          date: '2026-07-29',
          total: 29_99,
          items: [['Book', 29_99]],
        }),
        '2026-07-29T12:00:01.000Z',
      ),
      messageId: first.messageId,
    };

    expect(bundleReceiptPhotos([first, second])).toHaveLength(2);
  });

  it('does not merge same-value disjoint receipts attached to one Talk message', () => {
    const first = candidate(
      1,
      proposal({
        merchant: 'Amazon',
        date: '2026-07-29',
        total: 19_99,
        items: [['Cable', 19_99]],
      }),
      '2026-07-29T12:00:00.000Z',
    );
    const second = {
      ...candidate(
        2,
        proposal({
          merchant: 'Amazon',
          date: '2026-07-29',
          total: 19_99,
          items: [['Book', 19_99]],
        }),
        '2026-07-29T12:00:01.000Z',
      ),
      messageId: first.messageId,
    };

    expect(bundleReceiptPhotos([first, second])).toHaveLength(2);
  });

  it('does not merge different merchants that reuse the same receipt reference', () => {
    const first = candidate(
      1,
      proposal({
        merchant: 'Example Market',
        date: '2026-07-29',
        total: 19_99,
        reference: '1234',
        items: [['Cable', 19_99]],
      }),
      '2026-07-29T12:00:00.000Z',
    );
    const second = candidate(
      2,
      proposal({
        merchant: 'Corner Store',
        date: '2026-07-29',
        total: 19_99,
        reference: '1234',
        items: [['Book', 19_99]],
      }),
      '2026-07-29T12:00:01.000Z',
    );

    expect(bundleReceiptPhotos([first, second])).toHaveLength(2);
  });

  it('groups disjoint partial pages from one Talk message when a total is missing', () => {
    const first = candidate(
      1,
      proposal({
        merchant: 'Example Market',
        date: '2026-07-29',
        items: [['Paper towels', 12_99]],
      }),
      '2026-07-29T12:00:00.000Z',
    );
    const second = {
      ...candidate(
        2,
        proposal({
          merchant: 'Example Market',
          date: '2026-07-29',
          total: 37_98,
          items: [['Dish soap', 24_99]],
        }),
        '2026-07-29T12:00:01.000Z',
      ),
      messageId: first.messageId,
    };

    const bundles = bundleReceiptPhotos([first, second]);

    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.receipt.lineItems).toHaveLength(2);
    expect(bundles[0]?.receipt.amounts.total.valueMinor).toBe(37_98);
  });

  it('keeps ambiguous disjoint partial receipts separate even in one Talk message', () => {
    const first = candidate(
      1,
      proposal({
        merchant: 'Example Market',
        date: '2026-07-29',
        items: [['Paper towels', 12_99]],
      }),
      '2026-07-29T12:00:00.000Z',
    );
    const second = {
      ...candidate(
        2,
        proposal({
          merchant: 'Example Market',
          date: '2026-07-29',
          total: 24_99,
          items: [['Dish soap', 24_99]],
        }),
        '2026-07-29T12:00:01.000Z',
      ),
      messageId: first.messageId,
    };

    expect(bundleReceiptPhotos([first, second])).toHaveLength(2);
  });

  it('groups overlapping pages when one photo does not show the total', () => {
    const bundles = bundleReceiptPhotos([
      candidate(
        1,
        proposal({
          merchant: 'Example Market',
          date: '2026-07-29',
          items: [['Paper towels', 12_99]],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
      candidate(
        2,
        proposal({
          merchant: 'Example Market',
          date: '2026-07-29',
          total: 37_98,
          items: [
            ['Paper towels', 12_99],
            ['Dish soap', 24_99],
          ],
        }),
        '2026-07-29T12:02:00.000Z',
      ),
    ]);

    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.receipt.amounts.total.valueMinor).toBe(37_98);
  });

  it('does not merge identical totals when the item evidence conflicts', () => {
    const bundles = bundleReceiptPhotos([
      candidate(
        1,
        proposal({
          merchant: 'Amazon',
          date: '2026-07-29',
          total: 19_99,
          items: [['Cable', 19_99]],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
      candidate(
        2,
        proposal({
          merchant: 'Amazon',
          date: '2026-07-29',
          total: 19_99,
          items: [['Book', 19_99]],
        }),
        '2026-07-29T12:01:00.000Z',
      ),
    ]);

    expect(bundles).toHaveLength(2);
  });

  it('does not merge weak same-store photos merely because one item overlaps', () => {
    const bundles = bundleReceiptPhotos([
      candidate(
        1,
        proposal({
          merchant: 'Costco',
          items: [
            ['Milk', 6_49],
            ['Bread', 4_99],
          ],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
      candidate(
        2,
        proposal({
          merchant: 'Costco',
          items: [
            ['Milk', 6_49],
            ['Coffee', 18_99],
          ],
        }),
        '2026-07-29T12:02:00.000Z',
      ),
    ]);

    expect(bundles).toHaveLength(2);
  });

  it('does not let an itemless photo bridge two conflicting receipts', () => {
    const bundles = bundleReceiptPhotos([
      candidate(
        1,
        proposal({
          merchant: 'Amazon',
          date: '2026-07-29',
          total: 19_99,
          items: [['Cable', 19_99]],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
      candidate(
        2,
        proposal({
          merchant: 'Amazon',
          date: '2026-07-29',
          total: 19_99,
        }),
        '2026-07-29T12:01:00.000Z',
      ),
      candidate(
        3,
        proposal({
          merchant: 'Amazon',
          date: '2026-07-29',
          total: 19_99,
          items: [['Book', 19_99]],
        }),
        '2026-07-29T12:02:00.000Z',
      ),
    ]);

    expect(bundles).toHaveLength(2);
    expect(bundles.every((bundle) => bundle.sources.length < 3)).toBe(true);
  });

  it('keeps every photo in a bundle inside the configured time window', () => {
    const receipt = proposal({
      merchant: 'Costco',
      date: '2026-07-29',
      total: 128_82,
    });
    const bundles = bundleReceiptPhotos([
      candidate(1, receipt, '2026-07-29T12:00:00.000Z'),
      candidate(2, receipt, '2026-07-29T12:14:00.000Z'),
      candidate(3, receipt, '2026-07-29T12:28:00.000Z'),
    ]);

    expect(bundles).toHaveLength(2);
    expect(bundles.every((bundle) => bundle.sources.length < 3)).toBe(true);
  });

  it('deduplicates exact source hashes', () => {
    const first = candidate(
      1,
      proposal({ merchant: 'Costco', date: '2026-07-29', total: 128_82 }),
      '2026-07-29T12:00:00.000Z',
    );
    const duplicate = {
      ...first,
      eventId: candidate(2, first.receipt, first.receivedAt).eventId,
    };

    const bundles = bundleReceiptPhotos([first, duplicate]);

    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.sources).toHaveLength(1);
  });

  it('builds a revisioned facts-only Actual receipt record', () => {
    const bundle = bundleReceiptPhotos([
      candidate(
        1,
        proposal({
          merchant: 'Costco',
          date: '2026-07-29',
          total: 128_82,
          items: [['Milk', 6_49]],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
    ])[0]!;

    const first = buildActiveReceiptRecord(bundle);
    const second = buildActiveReceiptRecord(bundle, first);

    expect(first).toMatchObject({
      schemaVersion: 'household-finance.receipt.v1',
      receiptId: bundle.receiptId,
      revision: 1,
      status: 'active',
      merchant: 'Costco',
      currency: 'CAD',
      amounts: { totalMinor: 128_82 },
      items: [{ description: 'Milk', totalMinor: 6_49 }],
    });
    expect(first).not.toHaveProperty('categories');
    expect(first).not.toHaveProperty('linkedTransactionIds');
    expect(second.revision).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('preserves repeated identical lines within one receipt', () => {
    const receipt = proposal({
      merchant: 'Example Market',
      date: '2026-07-29',
      total: 14_97,
      items: [
        ['Canned beans', 4_99],
        ['Canned beans', 4_99],
        ['Canned beans', 4_99],
      ],
    });
    const bundle = bundleReceiptPhotos([
      candidate(1, receipt, '2026-07-29T12:00:00.000Z'),
      candidate(2, receipt, '2026-07-29T12:01:00.000Z'),
    ])[0]!;

    expect(bundle.receipt.lineItems).toHaveLength(3);
    expect(buildActiveReceiptRecord(bundle).items).toHaveLength(3);
  });

  it('keeps authenticated household purpose notes with a new canonical receipt', () => {
    const source = {
      ...candidate(
        1,
        proposal({
          merchant: 'Book Store',
          date: '2026-07-29',
          total: 24_99,
          items: [['Picture book', 24_99]],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
      captionHint: "Elia's birthday present.",
    };
    const bundle = bundleReceiptPhotos([source])[0]!;

    expect(buildActiveReceiptRecord(bundle)).toMatchObject({
      householdNotes: [
        {
          text: "Elia's birthday present.",
          receivedAt: '2026-07-29T12:00:00.000Z',
          talk: { actorId: 'alex', messageId: 'message-1' },
        },
      ],
    });
  });

  it('does not store the Talk attachment placeholder as a household note', () => {
    const source = {
      ...candidate(
        1,
        proposal({
          merchant: 'Costco Wholesale',
          date: '2026-07-29',
          total: 24_99,
          items: [['253230 DRUMSTK', 24_99]],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
      captionHint: '{file}',
    };

    expect(
      buildActiveReceiptRecord(bundleReceiptPhotos([source])[0]!),
    ).not.toHaveProperty('householdNotes');
  });

  it('keeps Costco TPD discount rows out of canonical purchased items', () => {
    const extracted = proposal({
      merchant: 'Costco Wholesale',
      date: '2026-07-07',
      total: 17_656,
      items: [
        ['1837708 MAX+ 2YR PP', 13_999],
        ['1328782 HOMO MILK 2L', 918],
        ['1452130 GOOGLE B/V', 1_999],
        ['2073942 TPD/GLENTEL', 1_999],
        ['1328431 WHIPP.CREAM', 639],
      ],
    });
    extracted.amounts = {
      subtotal: amount(15_556),
      tax: amount(2_100),
      discount: amount(1_999),
      tip: amount(0),
      total: amount(17_656),
    };

    const record = buildActiveReceiptRecord(
      bundleReceiptPhotos([
        candidate(1, extracted, '2026-07-07T12:00:00.000Z'),
      ])[0]!,
    );

    expect(record.items.map((item) => item.description)).toEqual([
      '1837708 MAX+ 2YR PP',
      '1328782 HOMO MILK 2L',
      '1452130 GOOGLE B/V',
      '1328431 WHIPP.CREAM',
    ]);
    expect(record.extraction).not.toHaveProperty('automaticProcessingBlocked');
    expect(receiptRecordItemDetailsComplete(record)).toBe(true);
  });

  it('does not backfill preexisting captions but keeps a note from a newly added photo', () => {
    const base = candidate(
      1,
      proposal({
        merchant: 'Book Store',
        date: '2026-07-29',
        total: 24_99,
        items: [['Picture book', 24_99]],
      }),
      '2026-07-29T12:00:00.000Z',
    );
    const firstBundle = bundleReceiptPhotos([base])[0]!;
    const previous = buildActiveReceiptRecord(firstBundle);

    const oldCaptionAppears = buildActiveReceiptRecord(
      bundleReceiptPhotos([
        { ...base, captionHint: 'Preexisting caption.' },
      ])[0]!,
      previous,
    );
    expect(oldCaptionAppears.householdNotes).toBeUndefined();

    const newerPhoto = {
      ...candidate(2, base.receipt, '2026-07-29T12:10:00.000Z'),
      captionHint: "Elia's birthday present.",
    };
    const revised = buildActiveReceiptRecord(
      bundleReceiptPhotos([base, newerPhoto])[0]!,
      previous,
    );
    expect(revised.householdNotes?.map((note) => note.text)).toEqual([
      "Elia's birthday present.",
    ]);
  });

  it('keeps a new caption when the same image is resent', () => {
    const base = candidate(
      1,
      proposal({
        merchant: 'Book Store',
        date: '2026-07-29',
        total: 24_99,
        items: [['Picture book', 24_99]],
      }),
      '2026-07-29T12:00:00.000Z',
    );
    const previous = buildActiveReceiptRecord(bundleReceiptPhotos([base])[0]!);
    const resend = {
      ...candidate(2, base.receipt, '2026-07-29T12:10:00.000Z'),
      sourceSha256: base.sourceSha256,
      captionHint: "Elia's birthday present.",
    };

    const revised = buildActiveReceiptRecord(
      bundleReceiptPhotos([base, resend])[0]!,
      previous,
    );

    expect(revised.householdNotes?.map((note) => note.text)).toEqual([
      "Elia's birthday present.",
    ]);
    expect(revised.updatedAt).toBe(resend.extractedAt);
    expect(revised.extraction.extractedAt).toBe(
      previous.extraction.extractedAt,
    );
    expect(revised).toMatchObject({
      merchant: previous.merchant,
      purchaseDate: previous.purchaseDate,
      currency: previous.currency,
      amounts: previous.amounts,
      paymentEvidence: previous.paymentEvidence,
      items: previous.items,
      extraction: {
        sourceSha256s: previous.extraction.sourceSha256s,
      },
    });
  });

  it('uses extraction order when a newer photo arrived before the prior revision finished', () => {
    const base = {
      ...candidate(
        1,
        proposal({
          merchant: 'Book Store',
          date: '2026-07-29',
          total: 24_99,
          items: [['Picture book', 24_99]],
        }),
        '2026-07-29T12:00:00.000Z',
      ),
      extractedAt: '2026-07-29T12:20:00.000Z',
    };
    const previous = buildActiveReceiptRecord(bundleReceiptPhotos([base])[0]!);
    const laterExtraction = {
      ...candidate(2, base.receipt, '2026-07-29T12:10:00.000Z'),
      extractedAt: '2026-07-29T12:21:00.000Z',
      captionHint: "Elia's birthday present.",
    };

    const revised = buildActiveReceiptRecord(
      bundleReceiptPhotos([base, laterExtraction])[0]!,
      previous,
    );

    expect(revised.householdNotes?.map((note) => note.text)).toEqual([
      "Elia's birthday present.",
    ]);
  });

  it('keeps caption corrections in authored order when extraction finishes out of order', () => {
    const receipt = proposal({
      merchant: 'Book Store',
      date: '2026-07-29',
      total: 24_99,
      items: [['Picture book', 24_99]],
    });
    const original = {
      ...candidate(1, receipt, '2026-07-29T12:00:00.000Z'),
      extractedAt: '2026-07-29T12:20:00.000Z',
      captionHint: 'Household purchase.',
    };
    const correction = {
      ...candidate(2, receipt, '2026-07-29T12:10:00.000Z'),
      extractedAt: '2026-07-29T12:11:00.000Z',
      captionHint: "Correction: Elia's birthday present.",
    };

    const record = buildActiveReceiptRecord(
      bundleReceiptPhotos([original, correction])[0]!,
    );

    expect(record.householdNotes?.map((note) => note.text)).toEqual([
      'Household purchase.',
      "Correction: Elia's birthday present.",
    ]);
  });

  it('stores one authenticated note for a caption shared by multiple files', () => {
    const receipt = proposal({
      merchant: 'Book Store',
      date: '2026-07-29',
      total: 24_99,
      items: [['Picture book', 24_99]],
    });
    const first = {
      ...candidate(1, receipt, '2026-07-29T12:00:00.000Z'),
      captionHint: "Elia's birthday present.",
    };
    const second = {
      ...candidate(2, receipt, '2026-07-29T12:00:00.000Z'),
      messageId: first.messageId,
      captionHint: "Elia's birthday present.",
    };

    const record = buildActiveReceiptRecord(
      bundleReceiptPhotos([first, second])[0]!,
    );

    expect(record.householdNotes).toHaveLength(1);
    expect(record.householdNotes?.[0]).toMatchObject({
      text: "Elia's birthday present.",
      talk: { messageId: first.messageId },
    });
  });

  it('normalizes OCR whitespace and Unicode before publishing canonical text', () => {
    const receipt = proposal({
      merchant: 'Cafe\u0301\nMarket',
      date: '2026-07-29',
      total: 12_34,
      reference: ' Order\t123 ',
      items: [['Milk\nand\tbread', 12_34]],
    });
    const bundle = bundleReceiptPhotos([
      candidate(1, receipt, '2026-07-29T12:00:00.000Z'),
    ])[0]!;

    expect(buildActiveReceiptRecord(bundle)).toMatchObject({
      merchant: 'Café Market',
      receiptReference: 'Order 123',
      items: [{ description: 'Milk and bread' }],
    });
  });
});
