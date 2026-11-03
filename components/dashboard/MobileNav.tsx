
import type { Section } from './types'
import { BiStar } from 'react-icons/bi'
import { GiMoneyStack, GiShoppingCart } from 'react-icons/gi'
import { FaSackDollar } from 'react-icons/fa6'
import { Boxes } from 'lucide-react'

export function MobileNav({
  section,
  go,
}: {
  section: Section
  go: (s: Section) => void
}) {
  const items = [
    {
      label: 'Stocks',
      section: 'Stocks',
      icon: GiShoppingCart,
    },
    {
      label: 'Debt',
      section: 'Debt',
      icon: FaSackDollar,
    },
    {
      label: 'Overview',
      section: 'Overview',
      icon: BiStar,
    },
    {
      label: 'Paid',
      section: 'Paid',
      icon: GiMoneyStack,
    },
    { label: 'Store', section: 'Store', icon: Boxes },
  ]

  return (
    <nav className="fixed bottom-0 left-0  right-0 z-40 border-t border-slate-200 bg-white/95 px-3 pb-3 pt-2 shadow-[0_-10px_30px_rgba(15,23,42,0.08)] backdrop-blur-md 
    md:hidden dark:border-slate-700 dark:bg-[#163d25]/95">
      <div className="mx-auto grid max-w-2xl grid-cols-5 items-end gap-1">
        {items.map((item) => {
          const active = section === item.section
          const Icon = item.icon
          const isOverview = item.section === 'Overview'

          return (
            <button
              key={item.label}
              type="button"
              onClick={() => go(item.section as Section)}
              className={`group flex min-h-[62px] flex-col items-center justify-center rounded-2xl px-1 transition-all duration-200 ${
                active
                  ? isOverview
                    ? 'bg-[#2e5035] text-white shadow-md'
                    : 'bg-slate-100 text-[#2e5035] dark:bg-green-800 dark:text-white'
                  : 'text-slate-500 hover:bg-slate-100 hover:text-[#2e5035] dark:text-slate-300 dark:hover:bg-green-900/60 dark:hover:text-white'
              }`}
            >
              <Icon
                className={`mb-1 transition-all duration-200 ${
                  isOverview ? 'h-6 w-6' : 'h-5 w-5'
                }`}
              />

              <span className="text-[10px] font-medium leading-tight">
                {item.label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

export default MobileNav
