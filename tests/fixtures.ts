import type { Ledger } from '../src/actual.js';
import { canonical, parsePurchase, PURCHASE_PREFIX } from '../src/domain.js';
import type { Purchase, Transaction } from '../src/domain.js';
export const transaction = (): Transaction => ({
  id: 'transaction-one',
  account: 'card',
  date: '2026-09-04',
  amount: -1575,
  payee: 'payee',
  merchant: 'Example Market',
  notes: 'My handwritten memo',
  category: null,
  imported: true,
  transfer: false,
  starting: false,
  children: [],
});
export const purchase = (): Purchase =>
  parsePurchase({
    schema: 'purchase.v2',
    id: 'purchase-one',
    revision: 1,
    state: 'pending',
    merchant: 'Example Market',
    date: '2026-09-04',
    currency: 'CAD',
    total: 1575,
    subtotal: 1500,
    tax: 75,
    shipping: null,
    discount: null,
    reference: null,
    payment: 'card',
    items: [
      { description: 'Milk', quantity: 2, unitPrice: 500, amount: 1000 },
      { description: 'Notebook', quantity: 1, unitPrice: 500, amount: 500 },
    ],
    sources: [
      {
        hash: 'a'.repeat(64),
        url: 'https://cloud.example.test/receipt.jpg',
        mediaType: 'image/jpeg',
        messageId: '1',
      },
    ],
    annotations: [],
    provenance: {
      method: 'synthetic',
      model: null,
      at: '2026-09-04T12:00:00Z',
    },
    transactions: [],
    allocations: [],
  });
export class FakeLedger implements Ledger {
  rows: Transaction[] = [transaction()];
  notes = new Map<string, string>();
  writes = 0;
  noteWrites = 0;
  loseWriteReply = false;
  loseNoteReply = false;
  async sync(): Promise<void> {}
  async categories() {
    return [
      { id: 'food', name: 'Food' },
      { id: 'school', name: 'School' },
    ];
  }
  async transactions() {
    return structuredClone(this.rows);
  }
  async note(id: string) {
    return this.notes.get(id) ?? null;
  }
  async writeNote(id: string, value: string) {
    this.noteWrites++;
    this.notes.set(id, value);
    if (this.loseNoteReply) {
      this.loseNoteReply = false;
      throw new Error('connection lost after note write');
    }
  }
  async update(expected: Transaction, desired: Transaction) {
    this.writes++;
    this.rows = this.rows.map((t) =>
      t.id === expected.id ? structuredClone(desired) : t,
    );
    if (this.loseWriteReply) {
      this.loseWriteReply = false;
      throw new Error('connection lost after transaction write');
    }
  }
  async purchases() {
    return [...this.notes]
      .filter(([id]) => id.startsWith(PURCHASE_PREFIX))
      .map(([, value]) => parsePurchase(JSON.parse(value)));
  }
  async ruleCategory(): Promise<string | null> {
    return null;
  }
  async report() {
    return { available: 0 };
  }
  seed(p: Purchase) {
    this.notes.set(PURCHASE_PREFIX + p.id, canonical(p));
  }
}
