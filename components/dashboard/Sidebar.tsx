import { ArrowLeftRight, Boxes, ChevronDown, CircleDollarSign, ClipboardList, CreditCard, LayoutDashboard, LogOut, Package, Settings, Sparkles, Store, Users, X, RotateCcw, RefreshCw, Clock3 } from 'lucide-react'

import type { Section } from './types'
import { nav } from './data'

const iconMap = {
  Overview: LayoutDashboard,
  Stocks: Package,
  'New Stocks': ClipboardList,
  Store: Boxes,
  Transfers: ArrowLeftRight,
  Debt: CreditCard,
  Paid: CircleDollarSign,
  Pending: Clock3,
  Settings: Settings,
  'Team members': Users,
  Returns: RotateCcw,
  'Sync Center': RefreshCw,
} as const

export function Sidebar({
  section,
  sidebar,
  settings,
  pendingCount = 0,
  onGo,
  onClose,
  onSignOut,
}: {
  section: Section
  sidebar: boolean
  settings: { workspace: string }
  pendingCount?: number
  onGo: (section: Section) => void
  onClose?: () => void
  onSignOut: () => void
}) {
  const adminPhone = (process.env.NEXT_PUBLIC_ADMIN_PHONE ?? '').replace(/[^\d+]/g, '')

  return (
    <aside className={`sidebar ${sidebar ? '' : 'sidebar-collapsed'}`}>
      <a href="/">
      <div className="brand">
        <div className="brand-mark"><Store /></div>
        {sidebar && <><strong>Micomerc</strong><span className="brand-dot" /></>}
        <button className="close-button md:hidden" onClick={onClose} aria-label="Close">
          <X />
        </button>
      </div>
      </a>

      <div className="workspace">
        <div className="avatar">AM</div>
        {sidebar && <div><b>{settings.workspace}</b><small>Workspace</small></div>}
        <ChevronDown className="workspace-chevron" />
      </div>

      <p className="nav-label">Workspace</p>
      <nav>
        {nav.map(({ label }) => {
          const Icon = iconMap[label as keyof typeof iconMap] || LayoutDashboard
          const displayLabel = label
          return (
            <button key={label} className={section === label ? 'nav-item active' : 'nav-item'} onClick={() => onGo(label as Section)} title={!sidebar ? displayLabel : undefined}>
              <Icon />
              <span className="nav-label-text">{displayLabel}</span>
              {label === 'Pending' && pendingCount > 0 && <b className="nav-count-badge">{pendingCount > 99 ? '99+' : pendingCount}</b>}
              {label === 'New Stocks' }
            </button>
          )
        })}
      </nav>

      <div className="sidebar-bottom">
        <p className="nav-label">Manage</p>
        <button className={`nav-item ${section === 'Settings' ? 'active' : ''}`} onClick={() => onGo('Settings')}>
          <Settings />
          {sidebar && <span>Settings</span>}
        </button>
        <button className={`nav-item ${section === 'Team members' ? 'active' : ''}`} onClick={() => onGo('Team members')}>
          <Users />
          {sidebar && <span>Team members</span>}
        </button>
        <div className="help-card">
          {sidebar && <>
            <Sparkles />
            <div>
              <b>Need a hand?</b>
              {adminPhone
                ? <a href={`tel:${adminPhone}`}><small>Call your admin</small></a>
                : <small>Set admin phone to enable calls</small>}
            </div>
          </>}
        </div>
        <button
          className="nav-item sidebar-sign-out"
          onClick={onSignOut}
          title={!sidebar ? 'Sign out' : undefined}
          aria-label="Sign out"
        >
          <LogOut />
          {sidebar && <span>Sign out</span>}
        </button>
      </div>
    </aside>
  )
}
