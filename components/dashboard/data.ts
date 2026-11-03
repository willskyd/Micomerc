export const nav = [
  { label: 'Overview', icon: 'overview' },
  { label: 'Stocks', icon: 'stocks' },
  { label: 'New Stocks', icon: 'new-stocks' },
  { label: 'Store', icon: 'store' },
  { label: 'Transfers', icon: 'transfers' },
  { label: 'Debt', icon: 'debt' },
  { label: 'Paid', icon: 'paid' },
  { label: 'Pending', icon: 'pending' },
  { label: 'Returns', icon: 'returns' },
  { label: 'Sync Center', icon: 'sync' },
] as const

export const money = (n: number, currency = 'NGN') =>
  new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0)
