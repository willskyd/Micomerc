import type { Activity } from './types'
import type { Dispatch, SetStateAction } from 'react'
import { useMemo, useState } from 'react'
import { money } from './utils'
import { FiCheck, FiClock } from 'react-icons/fi'
import { saveLocalRecordAndOperation, shouldAttemptServerRequest, writeLocalRecord } from '@/lib/offline-queue'

export async function persistRead(activity: Activity) {
  const operationId = crypto.randomUUID()
  const updated = { ...activity, read: true }
  const payload = { read: true, operationId }
  let response: Response | null = null
  if (shouldAttemptServerRequest()) {
    try { response = await fetch(`/api/activities/${activity.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) }
    catch (error) { if (!(error instanceof TypeError)) throw error }
  }
  if (response?.ok) {
    const saved = await response.json().catch(() => updated)
    await writeLocalRecord('activities', activity.id, saved, false)
    return
  }
  if (response) {
    const result = await response.json().catch(() => null)
    throw new Error(typeof result?.message === 'string' ? result.message : 'Failed to mark notification as read')
  }
  await saveLocalRecordAndOperation('activities', activity.id, updated, { id: operationId, type: 'activity.read', label: `Mark activity ${activity.id} as read`, target: `/api/activities/${activity.id}`, method: 'PATCH', payload, recordCollection: 'activities', recordId: activity.id })
  window.dispatchEvent(new Event('micomerc-queue-changed'))
}

export function Inbox({
  activities,
  selectedInbox,
  setSelectedInbox,
  setActivities,
}: {
  activities: Activity[]
  selectedInbox: Activity | null
  setSelectedInbox: Dispatch<SetStateAction<Activity | null>>
  setActivities: Dispatch<SetStateAction<Activity[]>>
}) {
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('All')
  const [dateFilter, setDateFilter] = useState('All time')
  const [showHistory, setShowHistory] = useState(false)

  const markAsRead = async (activity: Activity) => {
    setActivities((items) =>
      items.map((entry) =>
        entry.id === activity.id
          ? { ...entry, read: true }
          : entry
      )
    )

    setSelectedInbox({ ...activity, read: true })

    try {
      await persistRead(activity)
    } catch (error) {
      console.error('Failed to mark notification as read:', error)
    }
  }

  const markAllAsRead = async () => {
    setActivities((items) =>
      items.map((item) => ({ ...item, read: true }))
    )

    if (selectedInbox) {
      setSelectedInbox((current) =>
        current ? { ...current, read: true } : current
      )
    }

    try {
      const unreadActivities = activities.filter((item) => !item.read)

      await Promise.all(unreadActivities.map((activity) => persistRead(activity)))
    } catch (error) {
      console.error('Failed to mark all notifications as read:', error)
    }
  }

  const latestActivities = activities.slice(0, 10)
const olderActivities = activities.slice(10)

const hasActiveFilter =
  search.trim() !== '' ||
  typeFilter !== 'All' ||
  dateFilter !== 'All time'

const filteredHistory = useMemo(() => {
  const query = search.trim().toLowerCase()

  const now = new Date()

  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  )

  const startOfYesterday = new Date(startOfToday)
  startOfYesterday.setDate(startOfYesterday.getDate() - 1)

  const sevenDaysAgo = new Date(startOfToday)
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const thirtyDaysAgo = new Date(startOfToday)
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

  return activities.filter((item) => {
    /*
     * Search across all useful activity information.
     */
    const searchableText = [
      item.text,
      item.detail,
      item.customer,
      item.invoice,
      item.product,
      item.type,
      item.currency,
      item.time,
      item.quantity,
      item.amount,
      item.remaining,
    ]
      .filter(
        (value) =>
          value !== undefined &&
          value !== null &&
          value !== ''
      )
      .join(' ')
      .toLowerCase()

    const matchesSearch =
      !query || searchableText.includes(query)

    /*
     * Type filter.
     */
    const selectedType = typeFilter.toLowerCase()

    const matchesType =
      typeFilter === 'All' ||
      item.type?.toLowerCase() === selectedType

    /*
     * Date filter.
     */
    let matchesDate = true

    if (dateFilter !== 'All time') {
      const activityDate = new Date(item.time)

      if (!Number.isNaN(activityDate.getTime())) {
        if (dateFilter === 'Today') {
          matchesDate = activityDate >= startOfToday
        }

        if (dateFilter === 'Yesterday') {
          matchesDate =
            activityDate >= startOfYesterday &&
            activityDate < startOfToday
        }

        if (dateFilter === 'Last 7 days') {
          matchesDate = activityDate >= sevenDaysAgo
        }

        if (dateFilter === 'Last 30 days') {
          matchesDate = activityDate >= thirtyDaysAgo
        }
      } else {
        matchesDate = false
      }
    }

    return (
      matchesSearch &&
      matchesType &&
      matchesDate
    )
  })
}, [
  activities,
  search,
  typeFilter,
  dateFilter,
]) 

const historyActivities = hasActiveFilter ? filteredHistory : olderActivities
 

  const unreadCount = activities.filter(
    (item) => !item.read
  ).length

  const typeLabel = (type?: Activity['type']) => {
    switch (type) {
      case 'payment':
        return 'Payment'
      case 'debt':
        return 'Debt'
      case 'stock':
        return 'Stock'
      case 'product':
        return 'Product'
      case 'system':
        return 'System'
      default:
        return 'Activity'
    }
  }

  const renderActivity = (item: Activity) => (
    <button
      key={item.id}
      type="button"
      onClick={() => markAsRead(item)}
      className={`w-full rounded-xl border p-3 text-left transition ${
        selectedInbox?.id === item.id
          ? 'border-slate-300 bg-slate-100 dark:border-slate-600 dark:bg-slate-800'
          : 'border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/60 dark:hover:bg-slate-800'
      }`}
    >
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <b className="block truncate text-sm text-slate-900 dark:text-slate-50">
            {item.text}
          </b>

          <div className="mt-1 flex items-center gap-2">
            <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300">
              {typeLabel(item.type)}
            </span>

            <small className="text-[11px] text-slate-500">
              {item.time}
            </small>
          </div>
        </div>

        {!item.read && (
          <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-slate-900 dark:bg-slate-200" />
        )}
      </div>

      {item.detail && (
        <p className="mt-2 line-clamp-2 break-words text-xs leading-5 text-slate-500 dark:text-slate-400">
          {item.detail}
        </p>
      )}
    </button>
  )

  return (
<section className="inbox-section mb-20 w-full min-w-0 max-w-full space-y-5 rounded-2xl border border-slate-500 bg-white p-4 shadow-sm md:p-6 dark:border-slate-700 dark:bg-[#163d25]">      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
         <div className="inbox-title text-[11px] font-semibold uppercase tracking-[0.2em]">
            Inbox
           </div>
         <h2 className="inbox-title mt-2 text-2xl font-semibold">
           Notifications
           </h2>
          <p className="inbox-subtitle mt-1 text-sm">
          Your latest activity and notification history.
           </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
            {unreadCount} unread
          </span>

         <button
        type="button"
        onClick={markAllAsRead}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-medium text-slate-700 transition hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
         >
         <FiCheck className="text-sm" />
        <span className='text-[10px]'>Mark all read</span> 
     </button>
        </div>
      </div>

      {/* Main inbox */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <div>
           <h3 className="inbox-title text-sm font-semibold">
           Latest activity
          </h3>

         <p className="inbox-subtitle mt-1 text-xs">
          Showing the 10 most recent notifications.
         </p>
          </div>

          {olderActivities.length > 0 && (
           <button
           type="button"
          onClick={() => setShowHistory((value) => !value)}
         className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 !border !border-[#22522b] px-2.5 py-1.5 
         text-[11px] font-medium !text-white transition hover:bg-slate-600"
          >
        <FiClock className="text-sm" />
        <span className='text-[10px]'> {showHistory ? 'Hide history' : 'View history'}</span>
      </button>
          )}
        </div>

        <div className="grid min-w-0 grid-cols-1 gap-4">
          <div className="min-w-0 space-y-2">
            {latestActivities.length > 0 ? (
              latestActivities.map(renderActivity) 
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
                No notifications yet.
              </div>
            )}
          </div>

          {/* Details */}
          <div className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/60">
            {selectedInbox ? (
              <>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Message
                  </div>

                  {!selectedInbox.read && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-900 px-2 py-1 text-[10px] font-medium text-white dark:bg-slate-200 dark:text-slate-900">
                      <span className="h-2 w-2 rounded-full bg-white dark:bg-slate-900" />
                      Unread
                    </span>
                  )}
                </div>

                <h3 className="break-words text-xl font-semibold text-slate-900 dark:text-white">
                  {selectedInbox.text}
                </h3>

                <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                  <div className="mb-3 flex items-center justify-between text-sm font-medium text-slate-700 dark:text-slate-200">
                    <span>Details</span>

                    <span className="text-xs text-slate-500">
                      {typeLabel(selectedInbox.type)}
                    </span>
                  </div>

                  <div className="space-y-3">
                    <p className="break-words text-sm leading-6 text-slate-600 dark:text-slate-300">
                      {selectedInbox.detail ??
                        'No additional message details available.'}
                    </p>

                    {selectedInbox.type === 'payment' && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {selectedInbox.customer && (
                          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">
                              Customer
                            </div>

                            <div className="mt-1 break-words font-medium text-slate-900 dark:text-white">
                              {selectedInbox.customer}
                            </div>
                          </div>
                        )}

                        {selectedInbox.invoice && (
                          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">
                              Invoice
                            </div>

                            <div className="mt-1 break-words font-medium text-slate-900 dark:text-white">
                              {selectedInbox.invoice}
                            </div>
                          </div>
                        )}

                        {selectedInbox.amount !== undefined && (
                          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">
                              Amount paid
                            </div>

                            <div className="mt-1 break-words font-medium text-slate-900 dark:text-white">
                              {money(
                                selectedInbox.amount,
                                selectedInbox.currency
                              )}
                            </div>
                          </div>
                        )}

                        {selectedInbox.remaining !== undefined && (
                          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">
                              Remaining balance
                            </div>

                            <div className="mt-1 break-words font-medium text-slate-900 dark:text-white">
                              {money(
                                selectedInbox.remaining,
                                selectedInbox.currency
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {(selectedInbox.type === 'stock' ||
                      selectedInbox.type === 'product') && (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {selectedInbox.product && (
                          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">
                              Product
                            </div>

                            <div className="mt-1 break-words font-medium text-slate-900 dark:text-white">
                              {selectedInbox.product}
                            </div>
                          </div>
                        )}

                        {selectedInbox.quantity !== undefined && (
                          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">
                              Quantity
                            </div>

                            <div className="mt-1 break-words font-medium text-slate-900 dark:text-white">
                              {selectedInbox.quantity} units
                            </div>
                          </div>
                        )}

                        {selectedInbox.invoice && (
                          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">
                              Invoice
                            </div>

                            <div className="mt-1 break-words font-medium text-slate-900 dark:text-white">
                              {selectedInbox.invoice}
                            </div>
                          </div>
                        )}

                        {selectedInbox.detail && (
                          <div className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800 sm:col-span-2">
                            <div className="text-[10px] uppercase tracking-wide text-slate-500">
                              Activity details
                            </div>

                            <div className="mt-1 break-words text-sm leading-6 text-slate-700 dark:text-slate-200">
                              {selectedInbox.detail}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-5 text-xs text-slate-500">
                  Received {selectedInbox.time}
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-500">
                Select a notification to view the full details.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* History */}
      {(showHistory || hasActiveFilter) && (
        <div className="border-t border-slate-200 pt-5 dark:border-slate-700">
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
             {hasActiveFilter ? 'Search results' : 'Notification history'}
           </h3>

           <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
         {hasActiveFilter
          ? `${historyActivities.length} matching notification${historyActivities.length === 1 ? '' : 's'} found.`
         : 'Search and filter your complete notification history without deleting anything.'}
         </p>
          </div>

          {/* Search and filters */}
          <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr),180px,180px]">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search notifications..."
              className="w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            />

            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            >
              <option value="All">All types</option>
              <option value="Payment">Payments</option>
              <option value="Debt">Debt</option>
              <option value="Stock">Stock</option>
              <option value="Product">Products</option>
              <option value="System">System</option>
            </select>

            <select
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            >
              <option>All time</option>
              <option>Today</option>
              <option>Yesterday</option>
              <option>Last 7 days</option>
              <option>Last 30 days</option>
            </select>
          </div>

          <div className="mt-4 max-h-[1000px] space-y-2 overflow-y-auto overscroll-contain pr-1">
            {historyActivities.length > 0 ? (
              historyActivities.map(renderActivity)
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
                {hasActiveFilter ? 'No matching notifications found.' : 'No older notifications.'}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export default Inbox
