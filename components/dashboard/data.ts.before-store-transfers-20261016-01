import type { Activity, Debt, Product } from './types'

export const nav = [
  { label: 'Overview', icon: 'overview' },
  { label: 'Stocks', icon: 'stocks' },
  { label: 'New Stocks', icon: 'new-stocks' },
  { label: 'Debt', icon: 'debt' },
  { label: 'Paid', icon: 'paid' },
] as const

export const initialProducts: Product[] = [
  { id: 1, name: 'Premium Rice 25kg', model: 'MEC-RIC-2501', sku: 'RIC-2501', category: 'Groceries', stock: 248, price: 38.5, status: 'In stock' },
  { id: 2, name: 'Sunflower Oil 5L', model: 'MEC-OIL-5002', sku: 'OIL-5002', category: 'Groceries', stock: 86, price: 14.9, status: 'In stock' },
  { id: 3, name: 'Blue Label Tea', model: 'MEC-TEA-1008', sku: 'TEA-1008', category: 'Beverages', stock: 22, price: 8.25, status: 'Low stock' },
  { id: 4, name: 'Basmati Rice 10kg', model: 'MEC-RIC-1004', sku: 'RIC-1004', category: 'Groceries', stock: 0, price: 21.2, status: 'Out of stock' },
  { id: 5, name: 'Sparkling Water 12pk', model: 'MEC-WAT-1210', sku: 'WAT-1210', category: 'Beverages', stock: 64, price: 11.75, status: 'In stock' },
]

export const initialDebts: Debt[] = [
  {
    id: 1,
    customer: 'Harbor Market',
    invoice: 'INV-1048',
    items: [{ name: 'Premium Rice 25kg', price: 3080 }, { name: 'Sunflower Oil 5L', price: 1520 }],
    amount: 4600,
    payments: [{ id: 11, amount: 2100, date: 'Jun 18, 2026, 10:14 AM' }],
    due: 'Today',
    createdAt: 'Jun 12, 2026, 9:40 AM',
  },
  {
    id: 2,
    customer: 'Maya Grocers',
    invoice: 'INV-1045',
    items: [{ name: 'Basmati Rice 10kg', price: 1710 }, { name: 'Blue Label Tea', price: 1140 }],
    amount: 2850,
    payments: [{ id: 12, amount: 1500, date: 'Jun 20, 2026, 2:30 PM' }],
    due: 'Jun 28',
    createdAt: 'Jun 11, 2026, 3:12 PM',
  },
  {
    id: 3,
    customer: 'Westside Cafe',
    invoice: 'INV-1039',
    items: [{ name: 'Sparkling Water 12pk', price: 1920 }],
    amount: 1920,
    payments: [{ id: 13, amount: 1920, date: 'Jun 21, 2026, 11:05 AM' }],
    due: 'Jul 02',
    createdAt: 'Jun 09, 2026, 11:05 AM',
    paidAt: 'Jun 21, 2026, 11:05 AM',
  },
]

export const initialActivities: Activity[] = [
  { id: 1, text: 'Payment received from Westside Cafe', detail: 'A payment of ₦1,920 was received from Westside Cafe and matched to invoice INV-1039.', time: 'Jun 21, 2026, 11:05 AM', read: false },
  { id: 2, text: 'New stock receipt completed', detail: 'A stock receipt for 180 units was recorded for June grocery delivery with model MEC-RIC-2501.', time: 'Jun 20, 2026, 4:20 PM', read: false },
  { id: 3, text: 'Debt added for Harbor Market', detail: 'A new debt entry for Harbor Market was created with a total amount of ₦4,600.', time: 'Jun 12, 2026, 9:40 AM', read: true },
]

export const money = (n: number, currency = 'NGN') =>
  new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0)
