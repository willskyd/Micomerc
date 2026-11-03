export type Section = 'Overview' | 'Stocks' | 'New Stocks' | 'Debt' | 'Paid' | 'Settings' | 'Team members' | 'Inbox' | 'POS'

export type Product = {
  id: number
  name: string
  model: string
  sku: string
  barcode?: string
  category: string
  stock: number
  price: number
  status: string
}

export type DebtItem = {
  name: string
  price: number
}

export type Payment = {
  id: number
  amount: number
  date: string
}

export type Debt = {
  id: number
  customer: string
  invoice: string
  items: DebtItem[]
  amount: number
  payments: Payment[]
  due: string
  createdAt: string
  paidAt?: string
}

export type Activity = {
  id: number
  text: string
  detail?: string
  time: string
  read?: boolean
  type?: 'debt' | 'payment' | 'stock' | 'product' | 'system'
  amount?: number
  currency?: string
  customer?: string
  invoice?: string
  product?: string
  quantity?: number
  remaining?: number
}

export type Receipt = {
  id: number
  name: string
  model: string
  quantity: number
  invoice: string
  date: string
}

export type SaleLine = {
  productId: number
  name: string
  sku: string
  barcode: string
  quantity: number
  unitPriceMinor: number
  lineTotalMinor: number
}

export type Sale = {
  id: string
  receiptNumber: string
  businessName: string
  currency: string
  createdAt: string
  items: SaleLine[]
  subtotalMinor: number
  discountMinor: number
  taxMinor: number
  totalMinor: number
  payment: {
    method: 'cash'
    status: 'paid'
    amountTenderedMinor: number
    changeMinor: number
  }
}
