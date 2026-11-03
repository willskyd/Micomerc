import { ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'

export const now = () =>
  new Date().toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

export const money = (n: number, currency = 'NGN') =>
  new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0)

export function Stat({
  icon,
  label,
  value,
  change,
  positive,
}: {
  icon: ReactNode
  label: string
  value: string
  change?: string
  positive?: boolean
}) {
  return (
    <div className="stat-card">
      <div className="stat-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      {change && <small className={positive ? 'positive' : ''}>
        {positive && <ArrowUpRight />}
        {change}
      </small>}
    </div>
  )
}

export function daysAgo(date: string) {
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return 'recently'
  const days = Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86400000))
  return days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`
}

export function TrendingUpIcon() {
  return <ArrowUpRight />
}
