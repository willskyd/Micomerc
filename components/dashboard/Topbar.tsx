import { ArrowLeftRight, Bell, ChevronRight, Clock3, ClipboardList, Inbox, LogOut, Menu, Moon, RefreshCw, RotateCcw, Sun, Store } from 'lucide-react'

import type { Activity, Section } from './types'

export function Topbar({
  section,
  dark,
  notifications,
  menuOpen,
  activities,
  pendingCount = 0,
  onToggleTheme,
  onToggleNotifications,
  onOpenInbox,
  onOpenSection,
  onToggleMenu,
  onSignOut,
  onViewNotification,
}: {
  section: Section
  dark: boolean
  notifications: boolean
  menuOpen: boolean
  activities: Activity[]
  pendingCount?: number
  onToggleTheme: () => void
  onToggleNotifications: () => void
  onOpenInbox: () => void
  onOpenSection: (section: Section) => void
  onToggleMenu: () => void
  onSignOut: () => void
  onViewNotification: (notification: Activity) => void
}) {
  const unreadCount = activities.filter((item) => !item.read).length
  const latestActivities = activities.slice(0, 6)
  const adminPhone = (process.env.NEXT_PUBLIC_ADMIN_PHONE ?? '').replace(/[^\d+]/g, '')

  return (
    <header className="relative z-50 h-16 border-b border-slate-200 bg-white/90 backdrop-blur-sm md:h-[72px]  dark:border-slate-700  dark:bg-[#163d25]/90">
      <div className="flex h-full items-center gap-3 px-4 md:px-8">
        <a href="/">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-xl bg-slate-900 text-white shadow-sm dark:bg-green-700">
            <Store className="h-4 w-4" />
          </div>
          <strong className="hidden text-sm font-semibold text-slate-900 md:inline dark:text-slate-100">Micomerc</strong>
        </div>
        </a>

        <div className="hidden items-center gap-2 text-xs text-slate-500 md:flex">
          <span>Workspace</span>
          <ChevronRight className="h-3.5 w-3.5" />
          <b className="text-sm text-slate-900 dark:text-slate-100">{section}</b>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button className="grid h-9 w-9 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800" onClick={onToggleTheme} aria-label="Toggle theme">
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          <div className="relative">
            <button className="grid h-9 w-9 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800" onClick={onToggleNotifications} aria-label="Notifications">
              <Bell className="h-4 w-4" />
            </button>
            {unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-slate-900 px-1 text-[10px] font-semibold text-white dark:bg-slate-200 dark:text-slate-900">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
            {notifications && (
  <div
    className="
      absolute right-0 top-12 z-50 w-72 rounded-2xl border border-slate-200 bg-white p-3 shadow-xl
      dark:border-slate-700 dark:bg-[#163d25]

      /* Mobile only */
      max-md:fixed 
      max-md:left-0 
      max-md:right-auto 
      max-md:top-16 
      max-md:w-[260px] 
      max-md:rounded-l-none
      max-md:rounded-t-none
    "
  >
    <div className="mb-2 flex items-center justify-between px-1">
      <b className="text-sm text-slate-900 dark:text-slate-50">Activity</b>
      <span className="text-[11px] text-slate-500">{unreadCount} unread</span>
    </div>

    <div className="space-y-1">
      {latestActivities.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onViewNotification(a)}
          className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          {!a.read && (
            <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-slate-900 dark:bg-slate-200" />
          )}
          <span className="min-w-0 flex-1">
            <b className="block text-xs leading-snug text-slate-900 dark:text-slate-50">
              {a.text}
            </b>
            <small className="mt-1 block text-[11px] text-slate-500">
              {a.time}
            </small>
          </span>
        </button>
      ))}
    </div>
  </div>
)}
          </div>

          <button className="relative grid h-9 w-9 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800" onClick={onOpenInbox} aria-label="Inbox">
            <Inbox className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-slate-900 px-1 text-[10px] font-semibold text-white dark:bg-slate-200 dark:text-slate-900">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          <button className="grid h-9 w-9 place-items-center rounded-lg text-slate-600 transition hover:bg-slate-100 md:hidden dark:text-slate-200 dark:hover:bg-slate-800" onClick={onToggleMenu} aria-label="Open menu">
            <Menu className="h-4 w-4" />
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="absolute right-0 top-16 z-50 w-[280px] rounded-br-none rounded-t-none rounded-2xl border border-slate-200 bg-white p-3 shadow-2xl md:hidden dark:border-slate-700 dark:bg-[#163d25]">
          <div className="mb-3 flex items-center gap-3 rounded-xl bg-slate-100 px-3 py-2 dark:bg-green-800">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-slate-200 text-xs font-bold text-slate-200 dark:bg-green-700 dark:text-slate-100">AM</div>
            <div>
              <b className="block text-sm text-slate-900 dark:text-slate-50">Alex Morgan</b>
              <small className="text-xs text-slate-500">Administrator</small>
            </div>
          </div>

          <div className="space-y-1">
            {/* <button type="button" className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800" onClick={() => { onToggleMenu(); onOpenSection('Overview'); }}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-xs font-bold text-slate-700 dark:bg-slate-700 dark:text-slate-100">AM</span>
              Profile
            </button> */}
            <button type="button" aria-current={section === 'Pending' ? 'page' : undefined} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800 ${section === 'Pending' ? 'bg-slate-100 font-semibold dark:bg-slate-800' : ''}`} onClick={() => { onToggleMenu(); onOpenSection('Pending'); }}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-slate-700 dark:bg-green-700 dark:text-slate-100"><Clock3 className="h-4 w-4" /></span>
              <span className="flex-1">Pending</span>{pendingCount > 0 && <b className="rounded-full bg-red-600 px-2 py-0.5 text-xs text-white">{pendingCount > 99 ? '99+' : pendingCount}</b>}
            </button>
            <button type="button" aria-current={section === 'Returns' ? 'page' : undefined} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800 ${section === 'Returns' ? 'bg-slate-100 font-semibold dark:bg-slate-800' : ''}`} onClick={() => { onToggleMenu(); onOpenSection('Returns'); }}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-slate-700 dark:bg-green-700 dark:text-slate-100"><RotateCcw className="h-4 w-4" /></span>Returns
            </button>
            <button type="button" aria-current={section === 'Sync Center' ? 'page' : undefined} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800 ${section === 'Sync Center' ? 'bg-slate-100 font-semibold dark:bg-slate-800' : ''}`} onClick={() => { onToggleMenu(); onOpenSection('Sync Center'); }}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-slate-700 dark:bg-green-700 dark:text-slate-100"><RefreshCw className="h-4 w-4" /></span>Sync
            </button>
            <button type="button" aria-current={section === 'New Stocks' ? 'page' : undefined} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800 ${section === 'New Stocks' ? 'bg-slate-100 font-semibold dark:bg-slate-800' : ''}`} onClick={() => { onToggleMenu(); onOpenSection('New Stocks'); }}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-slate-700 dark:bg-green-700 dark:text-slate-100"><ClipboardList className="h-4 w-4" /></span>Parking Shop
            </button>
            <button type="button" aria-current={section === 'Transfers' ? 'page' : undefined} className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-600 dark:text-slate-200 dark:hover:bg-slate-800 ${section === 'Transfers' ? 'bg-slate-100 font-semibold dark:bg-slate-800' : ''}`} onClick={() => { onToggleMenu(); onOpenSection('Transfers'); }}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-slate-700 dark:bg-green-700 dark:text-slate-100"><ArrowLeftRight className="h-4 w-4" /></span>
              Transfers
            </button>
            <button type="button" className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800" onClick={() => { onToggleMenu(); onOpenSection('Settings'); }}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-green-700 dark:text-slate-100">⚙</span>
              Settings
            </button>
            <button type="button" className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800" onClick={() => { onToggleMenu(); onOpenSection('Team members'); }}>
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-green-700 dark:text-slate-100">👥</span>
              Team members
            </button>
            {adminPhone
              ? <a href={`tel:${adminPhone}`} className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-green-700 dark:text-slate-100">☎</span>
                  Call your admin
                </a>
              : <span className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-500 dark:text-slate-400">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200 text-xs font-semibold dark:bg-green-700">☎</span>
                  Set admin phone to enable calls
                </span>}
            <button type="button" className="mt-2 flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800" onClick={() => { onToggleMenu(); onSignOut(); }}>
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </div>
      )}
    </header>
  )
}
