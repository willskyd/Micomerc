import { ArrowUpRight, ClipboardList, CreditCard, Package, ShoppingCart, Sparkles, Users } from 'lucide-react'

import { Stat, money } from '../utils'
import type { Section } from '../types'

export function OverviewSection({
  outstanding,
  salesMinor,
  currency,
  productCount,
  receiptCount,
  onGo,
}: {
  outstanding: number
  salesMinor: number | null
  currency: string
  productCount: number
  receiptCount: number
  onGo: (s: Section) => void
})  {
  return (
    <>
      <div className="welcome-card ">
        <div>
          <span className="eyebrow">Today&apos;s pulse</span>
          <h2>Everything is in view.</h2>
          <p>Track inventory movement, collect balances, and keep the team aligned.</p>
        </div>
        <div className="pulse-orb">
          <Sparkles />
        </div>
      </div>

      <div className="stat-grid overview-stat-grid">
  <Stat
    icon={<Package />}
    label="Products tracked"
    value={productCount.toLocaleString()}
    change="Products in inventory"
  />

  <Stat
    icon={<CreditCard />}
    label="Outstanding debt"
    value={money(outstanding, currency)}
    change="Current outstanding balance"
  />

  <Stat
    icon={<ShoppingCart />}
    label="Today’s sales"
    value={salesMinor === null ? '—' : money(salesMinor / 100, currency)}
    change="Completed sales today"
    positive
  />

  <Stat
    icon={<ClipboardList />}
    label="Stock receipts"
    value={receiptCount.toLocaleString()}
    change="Recorded stock deliveries"
  />
</div>

      <div className="quick-grid mb-20">
        <button onClick={() => onGo('Debt')}>
          <CreditCard />
          <b>Review debt</b>
          <span>See balances and payments</span>
          <ArrowUpRight />
        </button>
        <button onClick={() => onGo('New Stocks')}>
          <ClipboardList />
          <b>Recent stock</b>
          <span>Review incoming inventory</span>
          <ArrowUpRight />
        </button>
      </div>
    </>
  )
}
