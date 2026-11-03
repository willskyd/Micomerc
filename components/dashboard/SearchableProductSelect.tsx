'use client'

import { Check, ChevronDown, Search, X } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import type { Product } from './types'

export function SearchableProductSelect({ products, value, onChange, label = 'Search products', disabled = false, includeOutOfStock = false }: {
  products: Product[]
  value: string
  onChange: (productId: string) => void
  label?: string
  disabled?: boolean
  includeOutOfStock?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const optionsId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = products.find((product) => String(product.id) === value)
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return products.filter((product) => {
      if (!includeOutOfStock && product.stock <= 0) return false
      return !needle || `${product.name} ${product.sku} ${product.model} ${product.barcode ?? ''}`.toLocaleLowerCase().includes(needle)
    }).slice(0, 30)
  }, [includeOutOfStock, products, query])
  const choose = (product: Product) => {
    onChange(String(product.id))
    setQuery('')
    setOpen(false)
    setActiveIndex(0)
  }

  return <div className="search-product-select" ref={rootRef}>
    <div className="search-product-control">
      <Search aria-hidden="true" size={15} />
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={optionsId}
        value={open ? query : selected ? `${selected.name} · ${selected.sku || selected.model}` : query}
        disabled={disabled}
        placeholder="Search name, SKU, model, or barcode"
        onFocus={() => { setOpen(true); setQuery('') }}
        onChange={(event) => { setOpen(true); setQuery(event.target.value); setActiveIndex(0) }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, Math.max(0, matches.length - 1))) }
          if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)) }
          if (event.key === 'Enter' && open && matches[activeIndex]) { event.preventDefault(); choose(matches[activeIndex]) }
          if (event.key === 'Escape') { setOpen(false); setQuery('') }
        }}
        onBlur={(event) => {
          const next = event.relatedTarget
          if (next instanceof Node && rootRef.current?.contains(next)) return
          window.setTimeout(() => setOpen(false), 100)
        }}
      />
      {selected && !disabled ? <button type="button" aria-label="Clear selected product" onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(''); setQuery(''); setOpen(true) }}><X size={14} /></button> : <ChevronDown size={15} aria-hidden="true" />}
    </div>
    {open && !disabled && <div className="search-product-options" id={optionsId} role="listbox" aria-label="Product options">
      {matches.length ? matches.map((product, index) => <button
        type="button"
        role="option"
        aria-selected={String(product.id) === value}
        className={index === activeIndex ? 'is-active' : ''}
        key={product.id}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index)}
        onClick={() => choose(product)}
      ><span><b>{product.name}</b><small>{product.sku || product.model}{product.barcode ? ` · ${product.barcode}` : ''}</small></span><span className="search-product-stock">{product.stock.toLocaleString()} in stock{String(product.id) === value && <Check size={14} />}</span></button>) : <p>No matching available stock product.</p>}
    </div>}
  </div>
}
