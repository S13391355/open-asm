import type { DataSource } from 'typeorm';

export const ASSET_CSV_HEADERS = ['Asset ID', 'Asset', 'Target', 'IP addresses', 'Known ports', 'Enabled', 'First seen', 'Last seen'];

type CsvValue = string | number | boolean | Date | string[] | number[] | null;

/** Quote every cell and prevent spreadsheet formula execution from asset data. */
function csvCell(value: CsvValue): string {
  let text = Array.isArray(value) ? value.join('; ') : value instanceof Date ? value.toISOString() : String(value ?? '');
  if (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Start from hosts so assets without service rows are included exactly once. */
export async function assetInventoryCsv(source: Pick<DataSource, 'query'>, workspaceId: string): Promise<Buffer> {
  const rows = await source.query<Record<string, CsvValue>[]>(`
    SELECT a.id AS "Asset ID", a.value AS "Asset", t.value AS "Target",
      ARRAY(SELECT DISTINCT ip FROM (
        SELECT d.value AS ip FROM dns_records d
          WHERE d."assetId"=a.id AND d."workspaceId"=$1 AND d."recordType" IN ('A','AAAA')
        UNION SELECT host(o.ip) FROM ip_observations o
          WHERE o."assetId"=a.id AND o."workspaceId"=$1
      ) ips ORDER BY ip) AS "IP addresses",
      ARRAY(SELECT DISTINCT s.port FROM asset_services s
        WHERE s."assetId"=a.id AND s."workspaceId"=$1 ORDER BY s.port) AS "Known ports",
      a."isEnabled" AS "Enabled", a."createdAt" AS "First seen", a."lastSeenAt" AS "Last seen"
    FROM assets a JOIN targets t ON t.id=a."targetId"
    WHERE a."workspaceId"=$1 AND t."workspaceId"=$1
    ORDER BY a.value, a.id`, [workspaceId]);
  return Buffer.from('\uFEFF' + [ASSET_CSV_HEADERS.map(csvCell).join(','),
    ...rows.map(row => ASSET_CSV_HEADERS.map(header => csvCell(row[header])).join(',')),
  ].join('\r\n') + '\r\n', 'utf8');
}
