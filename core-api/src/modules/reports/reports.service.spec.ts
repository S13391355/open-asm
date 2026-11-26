import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { DataSource } from 'typeorm';
import { StorageService } from '@/modules/storage/storage.service';
import { Report } from './entities/report.entity';
import { ReportsService } from './reports.service';
import { VulnerabilityReportService } from './services/vulnerability-report.service';
import { SummaryReportService } from './services/summary-report.service';
import { AsqSavedQueriesService } from '@/modules/attack-surface-query/asq-saved-queries.service';
import { GetManyReportsQueryDto } from './dto/reports.dto';

jest.mock('./renderer/pdf-renderer', () => ({
  renderReportPdf: jest.fn().mockResolvedValue(Buffer.from('mock-pdf')),
}));

describe('ReportsService', () => {
  let service: ReportsService;
  let reportRepository: Repository<Report>;
  let storageService: StorageService;

  const mockReport = {
    id: '123e4567-e89b-12d3-a456-42614174000',
    userId: 'user-1',
    path: 'reports/test-report.pdf',
    fileName: 'test-report.pdf',
    workspace: { id: 'workspace-1' },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: DataSource, useValue: { query: jest.fn().mockResolvedValue([]) } },
        {
          provide: getRepositoryToken(Report),
          useValue: {
            findOne: jest.fn(),
            find: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(() => ({
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              orderBy: jest.fn().mockReturnThis(),
              skip: jest.fn().mockReturnThis(),
              take: jest.fn().mockReturnThis(),
              getCount: jest.fn(),
              getMany: jest.fn(),
            })),
          },
        },
        {
          provide: StorageService,
          useValue: {
            uploadFile: jest.fn(),
            deleteFile: jest.fn(),
            getPresignedDownloadUrl: jest.fn().mockResolvedValue({ url: 'https://example.invalid/download', expiresIn: 60 }),
          },
        },
        {
          provide: VulnerabilityReportService,
          useValue: {
            getVulnerabilityReportData: jest.fn(),
          },
        },
        {
          provide: SummaryReportService,
          useValue: {
            getSummaryReportData: jest.fn(),
          },
        },
        {
          provide: AsqSavedQueriesService,
          useValue: savedQueries,
        },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
    reportRepository = module.get<Repository<Report>>(
      getRepositoryToken(Report),
    );
    storageService = module.get<StorageService>(StorageService);
  });

  const savedQueries = {
    get: jest.fn(),
    runSpec: jest.fn(),
  };

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('stores a private asset CSV report for the requesting workspace and user', async () => {
    jest.spyOn(storageService, 'uploadFile').mockResolvedValue({ path: 'reports/assets.csv' });
    await service.generateAssetsCsvReport('workspace-one', 'user-one');
    expect(storageService.uploadFile).toHaveBeenCalledWith(
      expect.stringMatching(/^report-assets-.*\.csv$/), expect.any(Buffer), 'reports', 'text/csv; charset=utf-8',
    );
    expect(reportRepository.save).toHaveBeenCalledWith(expect.objectContaining({
      workspace: { id: 'workspace-one' }, user: { id: 'user-one' }, type: 'ASSETS_CSV', path: 'reports/assets.csv',
    }));
  });

  it.each([
    ['ASSETS_CSV', 'text/csv; charset=utf-8'], ['SUMMARY', 'application/pdf'],
  ])('presigns %s downloads with the correct MIME type', async (type, contentType) => {
    const builder = {
      where: jest.fn().mockReturnThis(), orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(), offset: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(1),
      getMany: jest.fn().mockResolvedValue([{ ...mockReport, type }]),
    };
    jest.spyOn(reportRepository, 'createQueryBuilder').mockReturnValue(builder as never);
    await service.getMany(Object.assign(new GetManyReportsQueryDto(), {
      limit: 10, page: 1, sortBy: 'createdAt', sortOrder: 'DESC',
    }), 'workspace-one');
    expect(storageService.getPresignedDownloadUrl).toHaveBeenCalledWith(expect.objectContaining({ contentType }));
  });

  describe('generateQueryReport', () => {
    it('runs the saved query consistently as the caller and stores a QUERY report', async () => {
      const scope = { workspaceId: 'workspace-1', permissions: ['asset.read'], caller: 'http' as const };
      savedQueries.get.mockResolvedValue({ id: 'q1', name: 'Exposed ports', description: null, spec: { queries: { p: { from: 'services' } } } });
      savedQueries.runSpec.mockResolvedValue({
        data: { p: { rows: [{ id: 's1', port: 443 }], nextCursor: null, truncated: false } },
        meta: { now: '', tookMs: 1, queries: {} },
      });
      jest.spyOn(storageService, 'uploadFile').mockResolvedValue({ path: 'reports/x.pdf' });

      await service.generateQueryReport(scope, 'user-1', 'q1');

      expect(savedQueries.get).toHaveBeenCalledWith('workspace-1', 'q1');
      expect(savedQueries.runSpec).toHaveBeenCalledWith(scope, {
        queries: { p: { from: 'services' } },
        options: { consistent: true, mode: 'interactive' },
      });
      expect(reportRepository.save).toHaveBeenCalledWith(expect.objectContaining({ type: 'QUERY', path: 'reports/x.pdf' }));
    });
  });

  describe('findById', () => {
    it('should return a report by id and workspace', async () => {
      jest
        .spyOn(reportRepository, 'findOne')
        .mockResolvedValue(mockReport as Report);

      const result = await service.findById('report-1', 'workspace-1');
      expect(result).toEqual(mockReport);
    });

    it('should throw NotFoundException if report not found', async () => {
      jest.spyOn(reportRepository, 'findOne').mockResolvedValue(null);

      await expect(
        service.findById('non-existent', 'workspace-1'),
      ).rejects.toThrow('Report not found');
    });
  });

  describe('deleteReport', () => {
    it('should delete a report and its file', async () => {
      jest
        .spyOn(reportRepository, 'findOne')
        .mockResolvedValue(mockReport as Report);
      jest
        .spyOn(reportRepository, 'remove')
        .mockResolvedValue(mockReport as Report);

      await expect(
        service.deleteReport('report-1', 'workspace-1'),
      ).resolves.not.toThrow();

      expect(storageService.deleteFile).toHaveBeenCalledWith(
        'test-report.pdf',
        'reports',
      );
      expect(reportRepository.remove).toHaveBeenCalledWith(mockReport);
    });

    it('should still remove from DB even if file does not exist', async () => {
      jest
        .spyOn(reportRepository, 'findOne')
        .mockResolvedValue(mockReport as Report);
      jest.spyOn(storageService, 'deleteFile').mockImplementation(() => {
        throw new Error('ENOENT');
      });
      jest
        .spyOn(reportRepository, 'remove')
        .mockResolvedValue(mockReport as Report);

      await expect(
        service.deleteReport('report-1', 'workspace-1'),
      ).resolves.not.toThrow();

      expect(reportRepository.remove).toHaveBeenCalledWith(mockReport);
    });
  });
});
