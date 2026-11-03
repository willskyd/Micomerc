import { Package, Search, SlidersHorizontal, MoreHorizontal } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { Stat, TrendingUpIcon, money } from '../utils'
import type { Product } from '../types'

export function StocksSection({
  products,
  query,
  setQuery,
  statusFilter,
  setStatusFilter,
  filteredProducts,
  notify,
  setProducts,
  setDeleteProduct,
}: {
  products: Product[]
  query: string
  setQuery: (value: string) => void
  statusFilter: string
  setStatusFilter: (value: string) => void
  filteredProducts: Product[]
  notify: (text: string) => void
  setProducts: React.Dispatch<React.SetStateAction<Product[]>>
  setDeleteProduct: (product: Product | null) => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  return (
    <>
      <div className="stat-grid">
        <Stat icon={<Package />} label="Total products" value={products.length.toLocaleString()} />
        <Stat icon={<TrendingUpIcon />} label="Total stock value" value={money(products.reduce((a, p) => a + p.stock * p.price, 0))} />
        <Stat icon={<Package />} label="Low stock items" value={products.filter((p) => p.status === 'Low stock').length.toString()} change="Needs attention" />
        <Stat icon={<Package />} label="Out of stock" value={products.filter((p) => p.stock === 0).length.toString()} />
      </div>

      <section className="panel">
        <Toolbar query={query} setQuery={setQuery} statusFilter={statusFilter} setStatusFilter={setStatusFilter} options={['All', 'In stock', 'Low stock', 'Out of stock']} />
        <ProductTable
          products={filteredProducts}
          onNotify={notify}
          onStatusChange={(id, status) => { setProducts((ps) => ps.map((p) => p.id === id ? { ...p, status } : p)); notify('Stock status updated') }}
          onEdit={(id, key, value) => setProducts((ps) => ps.map((p) => p.id === id ? { ...p, [key]: key === 'name' || key === 'model' ? value : Number(value) || 0 } : p))}
          onDelete={(id) => setDeleteProduct(products.find((p) => p.id === id) ?? null)}
          editingId={editingId}
          setEditingId={setEditingId}
        />
      </section>
    </>
  )
}

function Toolbar({ query, setQuery, statusFilter, setStatusFilter, options }: { query: string; setQuery: (value: string) => void; statusFilter: string; setStatusFilter: (value: string) => void; options: string[] }) {
  return (
    <div className="toolbar">
      <div className="search">
        <Search />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products, customers..." />
      </div>
      <div className="filter-select">
        <SlidersHorizontal />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter">
          <option value="All">All filters</option>
          {options.filter((x) => x !== 'All').map((x) => <option key={x}>{x}</option>)}
        </select>
      </div>
    </div>
  )
}

function ProductTable({
  products,
  onNotify,
  onStatusChange,
  onEdit,
  onDelete,
  editingId,
  setEditingId,
}: {
  products: Product[]
  onNotify: (s: string) => void
  onStatusChange: (id: number, status: string) => void
  onEdit: (id: number, key: 'stock' | 'price' | 'name' | 'model', value: string) => void
  onDelete: (id: number) => void
  editingId: number | null
  setEditingId: (id: number | null) => void
}) {
  const [openId, setOpenId] = useState<number | null>(null)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null)
  const buttonRefs = useRef<Record<number, HTMLButtonElement | null>>({})

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (openId === null) return
      const target = e.target as HTMLElement
      if (!target.closest('.stock-menu') && !target.closest('.more-button')) {
        setOpenId(null)
        setMenuPos(null)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [openId])

  const handleOpenMenu = (id: number) => {
  if (openId === id) {
    setOpenId(null)
    setMenuPos(null)
    return
  }

  const button = buttonRefs.current[id]
  if (!button) return

  const rect = button.getBoundingClientRect()
  const menuHeight = 160          // tighter estimate
  const gap = 4                   // smaller gap
  const spaceBelow = window.innerHeight - rect.bottom
  const openUp = spaceBelow < menuHeight + gap

  setMenuPos({
    top: openUp ? rect.top - menuHeight - gap : rect.bottom + gap,
    left: rect.right - 190,       // still aligned to the right of the button
    openUp,
  })
  setOpenId(id)
}

  const activeProduct = products.find((p) => p.id === openId)

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Category</th>
            <th>In stock</th>
            <th>Unit price</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>
                <div className="product-name">
                  <div className="product-thumb">
                    <Package />
                  </div>
                  {editingId === p.id ? (
                    <div className="flex w-full flex-col gap-2">
                      <input
                        className="rounded-lg border border-[#29352d] bg-white px-2 py-1 text-sm text-[#29352d] placeholder:text-[#29352d] dark:border-[#29352d] dark:bg-[#29352d] dark:text-white"
                        value={p.name ?? ''}
                        onChange={(e) => onEdit(p.id, 'name', e.target.value)}
                      />
                      <input
                        className="rounded-lg border border-[#29352d] bg-white px-2 py-1 text-xs text-[#29352d] placeholder:text-[#29352d] dark:border-[#29352d] dark:bg-[#29352d] dark:text-white"
                        value={p.model ?? ''}
                        onChange={(e) => onEdit(p.id, 'model', e.target.value)}
                      />
                    </div>
                  ) : (
                    <div>
                      <b>{p.name}</b>
                      <span>{p.model ?? p.sku}</span>
                    </div>
                  )}
                </div>
              </td>
              <td>{p.category}</td>
              <td>
                <input
                  className="table-number"
                  type="number"
                  min="0"
                  value={p.stock}
                  onChange={(e) => onEdit(p.id, 'stock', e.target.value)}
                  aria-label={`Stock for ${p.name}`}
                />{' '}
                units
              </td>
              <td>
                <input
                  className="table-number price"
                  type="number"
                  min="0"
                  step="0.01"
                  value={p.price}
                  onChange={(e) => onEdit(p.id, 'price', e.target.value)}
                  aria-label={`Price for ${p.name}`}
                />
              </td>
              <td>
                <select
                  className="status-control"
                  value={p.status}
                  onChange={(e) => onStatusChange(p.id, e.target.value)}
                  aria-label={`Status for ${p.name}`}
                >
                  <option>In stock</option>
                  <option>Low stock</option>
                  <option>Out of stock</option>
                  <option>Discontinued</option>
                </select>
              </td>
              <td className="row-actions">
           <button
          ref={(el: HTMLButtonElement | null) => {
         buttonRefs.current[p.id] = el
          }}
           className="more-button"
           onClick={() => handleOpenMenu(p.id)}
            aria-label={`More actions for ${p.name}`}
           aria-expanded={openId === p.id}
          >
           <MoreHorizontal />
             </button>
           </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Portal – menu renders outside the table so it can't be clipped */}
      {openId !== null &&
        menuPos &&
        activeProduct &&
        createPortal(
          <div
            className="stock-menu"
            style={{
              position: 'fixed',
              top: menuPos.top,
              left: Math.max(8, menuPos.left), // prevent going off left edge
              zIndex: 9999,
            }}
          >
            <button
              onClick={() => {
                onNotify(`${activeProduct.name} has ${activeProduct.stock} units available`)
                setOpenId(null)
                setMenuPos(null)
              }}
            >
              View stock details
            </button>
            <button
              onClick={() => {
                setEditingId(activeProduct.id)
                setOpenId(null)
                setMenuPos(null)
              }}
            >
              Edit product
            </button>
            <button
              onClick={() => {
                onStatusChange(
                  activeProduct.id,
                  activeProduct.stock === 0 ? 'In stock' : 'Out of stock'
                )
                setOpenId(null)
                setMenuPos(null)
              }}
            >
              Toggle availability
            </button>
            <button
              className="delete-btn"
              onClick={() => {
                onDelete(activeProduct.id)
                setOpenId(null)
                setMenuPos(null)
              }}
            >
              Delete stock
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}