import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDebtRequest } from './debt.js';

test('normalizeDebtRequest calculates total from product rows and keeps an invoice', () => {
  const debt = normalizeDebtRequest(
    {
      customer: 'Harbor Market',
      lines: [
        { productId: 1, quantity: 2, amount: 300 },
        { productId: 2, quantity: 1 },
      ],
    },
    [
      { id: 1, name: 'Rice', sku: 'RIC-25', model: 'RIC-25', category: 'Groceries', stock: 12, price: 150, status: 'In stock' },
      { id: 2, name: 'Beans', sku: 'BEA-10', model: 'BEA-10', category: 'Groceries', stock: 8, price: 80, status: 'In stock' },
    ]
  );

  assert.equal(debt.customer, 'Harbor Market');
  assert.equal(debt.amount, 380);
  assert.equal(debt.items.length, 2);
  assert.ok(debt.invoice.startsWith('DEBT-'));
  assert.equal(debt.items[0].quantity, 2);
  assert.equal(debt.items[1].quantity, 1);
});

test('normalizeDebtRequest saves free-text items and receipt number without stock tracking', () => {
  const debt = normalizeDebtRequest(
    {
      customer: 'Harbor Market',
      item: 'Rice x 2 bags\nCooking oil x 1 bottle',
      receiptNumber: 'RN-1048',
      amount: 4600,
    },
    [{ id: 1, name: 'Rice', stock: 12, price: 100 }]
  );

  assert.equal(debt.items.length, 1);
  assert.equal(debt.items[0].name, 'Rice x 2 bags\nCooking oil x 1 bottle');
  assert.equal(debt.items[0].price, 4600);
  assert.equal(debt.receiptNumber, 'RN-1048');
  assert.equal(debt.stockTracked, false);
});

test('normalizeDebtRequest falls back to product totals when amount values are blank', () => {
  const debt = normalizeDebtRequest(
    {
      customer: 'Harbor Market',
      amount: '',
      lines: [
        { productId: 1, quantity: 2, amount: '' },
        { productId: 2, quantity: 1, amount: null },
      ],
    },
    [
      { id: 1, name: 'Rice', price: 150, stock: 12 },
      { id: 2, name: 'Beans', price: 80, stock: 8 },
    ]
  );

  assert.equal(debt.amount, 380);
  assert.equal(debt.items[0].price, 300);
  assert.equal(debt.items[1].price, 80);
});

test('normalizeDebtRequest requires a free-text item description', () => {
  assert.throws(
    () => normalizeDebtRequest({ customer: 'Harbor Market', item: '  ', amount: 4600 }),
    /Items bought is required/
  );
});
