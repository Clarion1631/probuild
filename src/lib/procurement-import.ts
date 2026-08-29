import { createHash } from "node:crypto";
import readXlsxFile, { readSheetNames } from "read-excel-file/node";

const MAX_XLSX_BYTES = 15 * 1024 * 1024;

export type ProcurementXlsxLayoutVersion = "v1" | "v2" | "v3-simpson-hardware" | "v4-takeoff-breakdown";

export interface ParsedProcurementRow {
  rowNumber: number;
  description: string;
  vendorName: string | null;
  quantity: number | null;
  unitCost: number | null;
  needByDate: string | null;
  sourceProjectRef: string | null;
  raw: Record<string, string | number | Date | null>;
}

export interface ParsedProcurementXlsx {
  layoutVersion: ProcurementXlsxLayoutVersion;
  sourceSheetName: string;
  headerRowNumber: number;
  sha256: string;
  rows: ParsedProcurementRow[];
}

type ProcurementColumn = "description" | "vendorName" | "quantity" | "unitCost" | "needByDate" | "project" | "rowIdentifier";

interface Layout {
  version: ProcurementXlsxLayoutVersion;
  sheetName?: string;
  headerRowNumber?: number;
  columns: Partial<Record<ProcurementColumn, string>> & Pick<Record<ProcurementColumn, string>, "description">;
}

const LAYOUTS: Layout[] = [
  {
    version: "v1",
    columns: {
      description: "description",
      vendorName: "vendor",
      quantity: "quantity",
      unitCost: "unit cost",
      needByDate: "need by",
      project: "project",
    },
  },
  {
    version: "v2",
    columns: {
      description: "item description",
      vendorName: "vendor name",
      quantity: "qty",
      unitCost: "unit price",
      needByDate: "need by date",
      project: "project",
    },
  },
  {
    version: "v3-simpson-hardware",
    sheetName: "Order List",
    headerRowNumber: 5,
    columns: {
      rowIdentifier: "line",
      description: "description",
      quantity: "supplier qty",
    },
  },
  {
    version: "v4-takeoff-breakdown",
    sheetName: "Takeoff Breakdown",
    headerRowNumber: 6,
    columns: {
      rowIdentifier: "item #",
      description: "description",
      quantity: "quantity (w/ wastage)",
      unitCost: "unit cost (material)",
    },
  },
];

function header(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function stringCell(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function numberCell(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[$,\s]/g, "");
  if (!/^(?:\d+|\d+\.\d+|\.\d+)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function dateCell(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized ? null : normalized;
}

function findLayout(sheetName: string, headerRowNumber: number, headers: string[]): Layout | null {
  return LAYOUTS.find((layout) =>
    (layout.sheetName === undefined || layout.sheetName === sheetName)
    && (layout.headerRowNumber === undefined || layout.headerRowNumber === headerRowNumber)
    && Object.values(layout.columns).every((required) => headers.includes(required)),
  ) ?? null;
}

function isBlankRow(values: unknown[]): boolean {
  return values.every((value) => value === null || value === undefined || value === "");
}

function rawCells(headers: string[], values: unknown[]): Record<string, string | number | Date | null> {
  return Object.fromEntries(headers.map((name, index) => [name, (values[index] ?? null) as string | number | Date | null]));
}

function columnIndex(layout: Layout, headers: string[], column: ProcurementColumn): number | null {
  const expectedHeader = layout.columns[column];
  return expectedHeader === undefined ? null : headers.indexOf(expectedHeader);
}

export async function parseProcurementXlsx(bytes: Buffer): Promise<ParsedProcurementXlsx> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_XLSX_BYTES) {
    throw new Error("Procurement XLSX must be a non-empty file no larger than 15 MB");
  }

  const sheetNames = await readSheetNames(bytes);
  for (const [sheetIndex, sheetName] of sheetNames.entries()) {
    const sheet = await readXlsxFile(bytes, { sheet: sheetName });
    const candidateHeaderRows = sheetIndex === 0 ? [1, 5, 6] : [];

    for (const headerRowNumber of candidateHeaderRows) {
      const headerRow = sheet[headerRowNumber - 1];
      if (!headerRow) continue;
      const headers = headerRow.map(header);
      const layout = findLayout(sheetName, headerRowNumber, headers);
      if (!layout) continue;

      const indices = Object.fromEntries(
        (Object.keys(layout.columns) as ProcurementColumn[]).map((key) => [key, columnIndex(layout, headers, key)]),
      ) as Partial<Record<ProcurementColumn, number>>;

      const rows: ParsedProcurementRow[] = [];
      for (let rowIndex = headerRowNumber; rowIndex < sheet.length; rowIndex += 1) {
        const values = sheet[rowIndex];
        if (isBlankRow(values)) continue;
        // Named takeoff layouts contain prose notes after the line items. Their explicit
        // row identifier is numeric, so only a numeric identifier starts a material row.
        if (indices.rowIdentifier !== undefined && numberCell(values[indices.rowIdentifier]) === null) continue;
        const description = stringCell(values[indices.description!]);
        if (!description) throw new Error(`Row ${rowIndex + 1} is missing Description`);

        rows.push({
          rowNumber: rowIndex + 1,
          description,
          vendorName: indices.vendorName === undefined ? null : stringCell(values[indices.vendorName]),
          quantity: indices.quantity === undefined ? null : numberCell(values[indices.quantity]),
          unitCost: indices.unitCost === undefined ? null : numberCell(values[indices.unitCost]),
          needByDate: indices.needByDate === undefined ? null : dateCell(values[indices.needByDate]),
          sourceProjectRef: indices.project === undefined ? null : stringCell(values[indices.project]),
          raw: rawCells(headers, values),
        });
      }

      if (rows.length === 0) throw new Error("Procurement XLSX has no material rows");
      return {
        layoutVersion: layout.version,
        sourceSheetName: sheetName,
        headerRowNumber,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        rows,
      };
    }
  }

  throw new Error("Unsupported procurement XLSX layout");
}
