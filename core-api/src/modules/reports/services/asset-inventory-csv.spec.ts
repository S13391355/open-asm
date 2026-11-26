import { ASSET_CSV_HEADERS, assetInventoryCsv } from './asset-inventory-csv';

describe('asset inventory CSV', () => {
  const source = { query: jest.fn() };

  it('includes a host with no services and scopes every lookup to the caller workspace', async () => {
    source.query.mockResolvedValue([{ 'Asset ID': 'a1', Asset: 'example.nz', Target: 'example.nz',
      'IP addresses': [], 'Known ports': [], Enabled: false, 'First seen': new Date('2026-01-01T00:00:00Z'), 'Last seen': null }]);
    const csv = (await assetInventoryCsv(source, 'workspace-one')).toString('utf8');
    expect(csv).toBe('\uFEFF' + ASSET_CSV_HEADERS.map(header => `"${header}"`).join(',') + '\r\n' +
      '"a1","example.nz","example.nz","","","false","2026-01-01T00:00:00.000Z",""\r\n');
    const [sql, parameters] = source.query.mock.calls.at(-1)!;
    expect(parameters).toEqual(['workspace-one']);
    expect(sql).toContain('WHERE a."workspaceId"=$1 AND t."workspaceId"=$1');
    expect(sql).not.toContain('JOIN asset_services');
  });

  it('escapes commas, quotes and newlines, and preserves IP/port lists', async () => {
    source.query.mockResolvedValue([{ Asset: 'quoted "host",\r\nnext', 'IP addresses': ['192.0.2.1', '2001:db8::1'], 'Known ports': [80, 443] }]);
    const csv = (await assetInventoryCsv(source, 'workspace-one')).toString();
    expect(csv).toContain('"quoted ""host"",\r\nnext"');
    expect(csv).toContain('"192.0.2.1; 2001:db8::1","80; 443"');
  });

  it.each(['=HYPERLINK("https://invalid")', '+cmd', '-cmd', '@SUM(1)', ' \t=cmd', '\tcmd', '\rcmd'])('neutralises spreadsheet formula cell %j', async (value) => {
    source.query.mockResolvedValue([{ Asset: value }]);
    const csv = (await assetInventoryCsv(source, 'workspace-one')).toString();
    expect(csv).toContain(`"'${value.replace(/"/g, '""')}"`);
  });
});
