// Client-side export helpers for the admin dashboard.
// Zero external dependencies: CSV and PDF (via the browser print dialog, which
// can "Save as PDF") and JSON all work natively.

export type ExportFormat = "csv" | "pdf" | "json";

// The flat shape we export. Keep column order stable across all formats.
export interface ExportRow {
  "Domain Name": string;
  "Domain": string;
  "URL": string;
  "Status": string;
  "SSL (days)": string;
  "SSL Expiry": string;
  "SSL Issuer": string;
  "Domain Expiry (days)": string;
  "Domain Expiry": string;
  "Registrar": string;
  "Server IP": string;
  "Server/Tag": string;
  "Category": string;
}

const formatDate = (value: any): string => {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString();
};

const days = (value: any): string =>
  value === null || value === undefined ? "" : String(value);

const status = (uptime: any): string => {
  if (!uptime) return "Unknown";
  return uptime.status ? "Operational" : "Down";
};

// Map a raw domain object (as built in the admin page) to an export row.
export function domainToExportRow(domain: any): ExportRow {
  return {
    "Domain Name": domain.display_name || domain.domain_name || "",
    "Domain": domain.domain_name || "",
    "URL": domain.uptime_url || "",
    "Status": status(domain.uptime),
    "SSL (days)": days(domain.ssl?.days_remaining),
    "SSL Expiry": formatDate(domain.ssl?.expiry_date),
    "SSL Issuer": domain.ssl?.issuer || "",
    "Domain Expiry (days)": days(domain.domain_expiry?.days_remaining),
    "Domain Expiry": formatDate(domain.domain_expiry?.expiry_date),
    "Registrar": domain.domain_expiry?.registrar || "",
    "Server IP": domain.ip_records?.primary_ip || "",
    "Server/Tag": domain.tag || "",
    "Category": domain.category || "",
  };
}

const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const escapeCsv = (value: string): string => {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function toCsv(rows: ExportRow[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(escapeCsv).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCsv(String((row as any)[h] ?? ""))).join(","));
  }
  // BOM so Excel opens UTF-8 correctly.
  return "﻿" + lines.join("\r\n");
}

function toHtmlTable(rows: ExportRow[]): string {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${headers
          .map((h) => `<td>${escapeHtml(String((row as any)[h] ?? ""))}</td>`)
          .join("")}</tr>`
    )
    .join("");
  return `<table border="1"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function exportCsv(rows: ExportRow[], filename: string) {
  triggerDownload(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8;" }), `${filename}.csv`);
}

function exportJson(rows: ExportRow[], filename: string) {
  triggerDownload(
    new Blob([JSON.stringify(rows, null, 2)], { type: "application/json;charset=utf-8;" }),
    `${filename}.json`
  );
}

// PDF via a print window. The user picks "Save as PDF" in the print dialog.
function exportPdf(rows: ExportRow[], filename: string, title: string) {
  const win = window.open("", "_blank");
  if (!win) {
    alert("Please allow pop-ups to export as PDF.");
    return;
  }
  const generated = new Date().toLocaleString();
  win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(filename)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #666; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; }
  th { background: #f4f4f5; }
  tr:nth-child(even) td { background: #fafafa; }
  @media print { @page { size: landscape; margin: 12mm; } }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">${rows.length} domain(s) — generated ${escapeHtml(generated)}</div>
  ${toHtmlTable(rows)}
  <script>window.onload = function () { window.print(); };<\/script>
</body>
</html>`);
  win.document.close();
}

export function exportRows(
  format: ExportFormat,
  rows: ExportRow[],
  filename = "domains-export",
  title = "Domain Monitoring Export"
) {
  switch (format) {
    case "csv":
      return exportCsv(rows, filename);
    case "json":
      return exportJson(rows, filename);
    case "pdf":
      return exportPdf(rows, filename, title);
  }
}
