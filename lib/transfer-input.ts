import { InventoryError, parseDate, parseQuantity } from "@/lib/inventory";

export type NormalizedTransferLine = {
  productId: number;
  unit: "units" | "cartons";
  quantity: number;
  unitsPerCarton: number | null;
  stockUnits: number;
  manualSourceText?: string;
};

export function parseTransferInput(value: unknown) {
  if (typeof value !== "object" || value === null) throw new InventoryError("Transfer details are invalid");
  const body = value as Record<string, unknown>;
  const idempotencyKey = body.idempotencyKey;
  if (typeof idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new InventoryError("Transfer request key is invalid");
  const destinationBranchId = body.destinationBranchId;
  if (typeof destinationBranchId !== "string" || !destinationBranchId.trim() || destinationBranchId.length > 80) throw new InventoryError("Choose a destination branch");
  const transferDate = parseDate(body.transferDate, "Transfer date");
  const sourceLocation = typeof body.sourceLocation === "string" ? body.sourceLocation.trim() : "Main store";
  const rawManualItems = typeof body.manualItems === "string" ? body.manualItems.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (sourceLocation.length > 100 || rawManualItems.length > 4000 || notes.length > 1000) throw new InventoryError("Source, manual items, or notes exceed the allowed length");
  if (!Array.isArray(body.lines) || body.lines.length > 30) throw new InventoryError("Transfer product rows are invalid");
  const lines: NormalizedTransferLine[] = body.lines.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) throw new InventoryError(`Transfer row ${index + 1} is invalid`);
    const line = entry as Record<string, unknown>;
    if (typeof line.productId !== "number" || !Number.isSafeInteger(line.productId) || line.productId <= 0) throw new InventoryError(`Choose a catalog product for transfer row ${index + 1}`);
    const unit = line.unit;
    if (unit !== "units" && unit !== "cartons") throw new InventoryError(`Choose units or cartons for transfer row ${index + 1}`);
    let quantity: number;
    if (unit === "units") quantity = parseQuantity(line.quantity, `Quantity in row ${index + 1}`);
    else {
      if (typeof line.quantity !== "number" || !Number.isSafeInteger(line.quantity) || line.quantity <= 0 || line.quantity > 1_000_000) throw new InventoryError(`Carton quantity in row ${index + 1} must be a positive whole number`);
      quantity = line.quantity;
    }
    let unitsPerCarton: number | null = null;
    let stockUnits: number = quantity;
    if (unit === "cartons") {
      if (typeof line.unitsPerCarton !== "number" || !Number.isSafeInteger(line.unitsPerCarton) || line.unitsPerCarton <= 0 || line.unitsPerCarton > 100_000) throw new InventoryError(`Enter units per carton in row ${index + 1}`);
      unitsPerCarton = line.unitsPerCarton;
      stockUnits = quantity * unitsPerCarton;
      if (!Number.isSafeInteger(stockUnits) || stockUnits > 1_000_000_000) throw new InventoryError(`Transfer row ${index + 1} exceeds the supported quantity`);
    }
    const manualSourceText = typeof line.manualSourceText === "string" ? line.manualSourceText.trim() : undefined;
    if (manualSourceText && manualSourceText.length > 500) throw new InventoryError(`Manual match in row ${index + 1} is too long`);
    return { productId: line.productId, unit, quantity: Number(quantity), unitsPerCarton, stockUnits, ...(manualSourceText ? { manualSourceText } : {}) };
  });
  const confirmedText = new Set(lines.flatMap((line) => line.manualSourceText ? [line.manualSourceText] : []));
  const manualItems = rawManualItems.split(/\r?\n/).filter((line) => !confirmedText.has(line.trim())).join("\n").trim();
  if (!lines.length && !manualItems) throw new InventoryError("Add a stock product or describe a manual transfer item");
  return { idempotencyKey, destinationBranchId: destinationBranchId.trim(), transferDate, sourceLocation, lines, manualItems, notes };
}

export function aggregateTransferLines(lines: NormalizedTransferLine[]) {
  const result = new Map<number, number>();
  for (const line of lines) result.set(line.productId, Math.round(((result.get(line.productId) ?? 0) + line.stockUnits) * 1000) / 1000);
  return result;
}
