function parseNumericInput(value) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (typeof value !== 'number') return null;
  return Number.isFinite(value) ? value : null;
}

export function generateDebtInvoice() {
  const stamp = Date.now().toString(36).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `DEBT-${stamp}-${suffix}`;
}

export function normalizeDebtRequest(rawBody = {}, catalog = []) {
  if (!rawBody || typeof rawBody !== 'object') {
    throw new Error('Debt details must be a JSON object');
  }

  const productCatalog = Array.isArray(catalog) ? catalog : [];
  const customer = typeof rawBody.customer === 'string' ? rawBody.customer.trim() : '';
  if (!customer) {
    throw new Error('Customer name is required');
  }

  const receiptNumber = typeof rawBody.receiptNumber === 'string'
    ? rawBody.receiptNumber.trim()
    : typeof rawBody.receiptNumber === 'number'
      ? String(rawBody.receiptNumber).trim()
      : '';
  if (receiptNumber.length > 100) {
    throw new Error('Receipt number must be 100 characters or fewer');
  }

  const hasFreeTextItem = Object.hasOwn(rawBody, 'item');
  let items;

  if (hasFreeTextItem) {
    const itemDescription = typeof rawBody.item === 'string' ? rawBody.item.trim() : '';
    if (!itemDescription) {
      throw new Error('Items bought is required');
    }
    if (itemDescription.length > 4000) {
      throw new Error('Items bought must be 4000 characters or fewer');
    }

    const amount = parseNumericInput(rawBody.amount);
    if (amount === null || amount < 0) {
      throw new Error('Debt total is invalid');
    }

    items = [{ name: itemDescription, price: Number(amount) }];
  } else {
    const rawLines = Array.isArray(rawBody.lines)
      ? rawBody.lines
      : Array.isArray(rawBody.items)
        ? rawBody.items
        : [];

    if (!rawLines.length) {
      throw new Error('Add at least one product to the debt');
    }

    items = rawLines.map((line, index) => {
      if (!line || typeof line !== 'object') {
        throw new Error(`Debt row ${index + 1} is invalid`);
      }

      const productId = Number(line.productId ?? line.id);
      const quantity = Number(line.quantity);
      const product = productCatalog.find((entry) => Number(entry.id) === productId) || null;
      const amountFromInput = parseNumericInput(line.amount);
      const fallbackAmount = product && Number.isFinite(quantity) && quantity > 0
        ? Number(product.price) * quantity
        : 0;
      const amount = amountFromInput !== null && amountFromInput >= 0
        ? amountFromInput
        : fallbackAmount;

      if (!Number.isSafeInteger(productId) || productId <= 0) {
        throw new Error(`Select a valid product for debt row ${index + 1}`);
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error(`Enter a valid quantity for debt row ${index + 1}`);
      }

      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(`Enter a valid amount for debt row ${index + 1}`);
      }

      return {
        name: product?.name ?? `Product ${productId}`,
        productId,
        sku: product?.sku ?? product?.model ?? '',
        quantity,
        unitPrice: product ? Number(product.price) : 0,
        stockUnits: product ? Number(product.stock) : 0,
        price: Number(amount),
      };
    });
  }

  const rawAmount = parseNumericInput(rawBody.amount);
  const totalAmount = rawAmount !== null && rawAmount >= 0
    ? rawAmount
    : items.reduce((sum, item) => sum + Number(item.price || 0), 0);

  if (!Number.isFinite(totalAmount) || totalAmount < 0) {
    throw new Error('Debt total is invalid');
  }

  return {
    customer,
    invoice: typeof rawBody.invoice === 'string' && rawBody.invoice.trim()
      ? rawBody.invoice.trim()
      : generateDebtInvoice(),
    ...(receiptNumber ? { receiptNumber } : {}),
    items,
    stockTracked: !hasFreeTextItem,
    amount: Number(totalAmount.toFixed(2)),
    payments: Array.isArray(rawBody.payments) ? rawBody.payments : [],
    due: typeof rawBody.due === 'string' && rawBody.due.trim() ? rawBody.due.trim() : '30 days',
    createdAt: typeof rawBody.createdAt === 'string' && rawBody.createdAt.trim() ? rawBody.createdAt.trim() : new Date().toISOString(),
    ...(rawBody.paidAt ? { paidAt: String(rawBody.paidAt) } : {}),
  };
}
