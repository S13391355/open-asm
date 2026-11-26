import 'reflect-metadata';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { NodeAdapter } from '@nestjs/platform-node';
import { SwaggerModule, DocumentBuilder, type OpenAPIObject } from '@nestjs/swagger';
import { API_GLOBAL_PREFIX } from '../src/common/constants/app.constants';
import { WorkspacePermissionGuard } from '../src/common/guards/workspace-permission.guard';
import { ReportsController } from '../src/modules/reports/reports.controller';
import { ReportsService } from '../src/modules/reports/reports.service';

/** Generate the changed contract from real decorators without production services or a listener. */
async function main() {
  if (!process.argv[2]) throw new Error('A baseline OpenAPI document is required');
  const baseline = JSON.parse(readFileSync(resolve(process.argv[2]), 'utf8')) as OpenAPIObject;
  if (!baseline.paths?.['/api/reports/generate/summary']) throw new Error('Invalid API baseline');
  const module = await Test.createTestingModule({
    controllers: [ReportsController], providers: [{ provide: ReportsService, useValue: {} }],
  }).overrideGuard(WorkspacePermissionGuard).useValue({ canActivate: () => false }).compile();
  const app = module.createNestApplication(new NodeAdapter());
  app.setGlobalPrefix(API_GLOBAL_PREFIX);
  try {
    await app.init();
    const reports = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Reports contract').setVersion('1').build());
    if (!reports.paths['/api/reports/generate/assets-csv']?.post) throw new Error('CSV route missing from generated contract');
    baseline.paths = { ...baseline.paths, ...reports.paths };
    baseline.components = { ...baseline.components, schemas: { ...baseline.components?.schemas, ...reports.components?.schemas } };
    const output = resolve('../.open-api/open-api.json');
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(baseline));
  } finally { await app.close(); }
}
void main().catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
