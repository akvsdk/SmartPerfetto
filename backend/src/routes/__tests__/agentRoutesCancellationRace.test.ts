// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import {EventEmitter} from 'events';
import {attachFinalizationContext, takeFinalizationContext, type RuntimeFinalizationContext} from '../../agentRuntime/analysisFinalizationContext';
import {buildStrategyRegistrySnapshotFromDefinitions} from '../../agentv3/strategyLoader';
import {analysisDeliveryFingerprint} from '../../types/analysisDelivery';
import {createDataEnvelope} from '../../types/dataContract';
import {ArtifactStore} from '../../agentv3/artifactStore';
import type {IdentityResolutionV1} from '../../types/identityContract';
import {captureEvidenceTable} from '../../services/evidence/evidenceCapture';
import type {EvidenceReadView} from '../../services/evidence/evidenceReadView';
import * as finalization from '../../services/finalizeAnalysisResult';
import * as persistence from '../../services/persistAgentSession';
import * as summary from '../../services/managedTraceSummary';
import * as comparison from '../../services/comparisonAppendixService';
import * as sourceSupplement from '../../services/codebase/analysisSourceSupplement';
import * as contextAuthorization from '../../services/resolvedAnalysisContext';
import * as reports from '../reportRoutes';
import * as snapshots from '../../services/analysisResultSnapshotPipeline';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { sessionContextManager } from '../../agent/context/enhancedSessionContext';
import type { AnalysisResult } from '../../agent/core/orchestratorTypes';
import { ClaudeRuntime } from '../../agentRuntime/engines/claude';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { resetAgentEventStoreForTests } from '../../services/agentEventStore';
import { resetAnalysisRunStoreForTests } from '../../services/analysisRunStore';
import { ENTERPRISE_DB_PATH_ENV } from '../../services/enterpriseDb';
import { clearRunManifestLifecyclesForTests } from '../../services/selfEvolution/runManifestLifecycle';
import {
  getRunManifestStore,
  resetRunManifestStoreForTests,
} from '../../services/selfEvolution/runManifestStore';
import { SessionPersistenceService } from '../../services/sessionPersistenceService';
import {
  getTraceProcessorLeaseStore,
  setTraceProcessorLeaseStoreForTests,
} from '../../services/traceProcessorLeaseStore';
import {
  TraceProcessorService,
  setTraceProcessorServiceForTests,
  type TraceProcessor,
} from '../../services/traceProcessorService';
import { ENTERPRISE_DATA_DIR_ENV, writeTraceMetadata } from '../../services/traceMetadataStore';
import agentRoutes, {agentRoutesCancellationTestSeam} from '../agentRoutes';

const envKeys = [
  'SMARTPERFETTO_API_KEY',
  'SMARTPERFETTO_SSO_TRUSTED_HEADERS',
  ENTERPRISE_FEATURE_FLAG_ENV,
  ENTERPRISE_DB_PATH_ENV,
  ENTERPRISE_DATA_DIR_ENV,
  'UPLOAD_DIR',
  'SMARTPERFETTO_AGENT_RUNTIME',
  'SMARTPERFETTO_AI_ENABLED',
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/agent/v1', agentRoutes);
  return app;
}

function analystHeaders(testRequest: request.Test): request.Test {
  return testRequest
    .set('X-SmartPerfetto-SSO-User-Id', 'analyst-user')
    .set('X-SmartPerfetto-SSO-Email', 'analyst@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,agent:run,report:read');
}

function readyProcessor(traceId: string): TraceProcessor {
  return {
    id: `processor-${traceId}`,
    traceId,
    status: 'ready',
    activeQueries: 0,
    query: jest.fn(async () => ({ columns: [], rows: [], durationMs: 1 })),
    queryRaw: jest.fn(async () => Buffer.alloc(0)),
    destroy: jest.fn(),
  };
}

function restoreEnvironment(): void {
  for (const key of envKeys) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  jest.restoreAllMocks();
  setTraceProcessorServiceForTests(null);
  setTraceProcessorLeaseStoreForTests(null);
  SessionPersistenceService.resetForTests();
  resetAgentEventStoreForTests();
  resetAnalysisRunStoreForTests();
  clearRunManifestLifecyclesForTests();
  resetRunManifestStoreForTests();
  restoreEnvironment();
});

describe('agent analyze cancellation races', () => {
  it('cancels detached source enrichment without changing the completed primary run', async () => {
    const sessionId = 'session-source-enrichment-cancel';
    const runId = `${sessionId}:1`;
    const abortSession = jest.fn();
    const cleanupSession = jest.fn();
    const run = {
      runId,
      requestId: 'request-source-enrichment-cancel',
      sequence: 1,
      query: '完整审查源码',
      startedAt: Date.now(),
      completedAt: Date.now(),
      status: 'completed' as const,
    };
    const session = {
      sessionId,
      status: 'completed' as const,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      traceId: 'trace-source-enrichment-cancel',
      query: run.query,
      sseClients: [],
      sseEventSeq: 0,
      sseEventBuffer: [],
      runSequence: 1,
      activeRun: run,
      lastRun: run,
      runRegistry: {[runId]: run},
      analysisSourceEnrichment: {
        runId,
        status: 'running' as const,
        startedAt: Date.now(),
      },
      orchestrator: {abortSession, cleanupSession},
      logger: {info: jest.fn(), warn: jest.fn(), error: jest.fn()},
    } as any;
    agentRoutesCancellationTestSeam.setSession(sessionId, session);
    try {
      const result = await agentRoutesCancellationTestSeam.cancelSessionRun(
        sessionId,
        runId,
        'cancel source supplement',
      );

      expect(result).toMatchObject({
        outcome: 'source_enrichment_cancelled',
        runStatus: 'completed',
      });
      expect(session.status).toBe('completed');
      expect(run.status).toBe('completed');
      expect(session.analysisSourceEnrichment.status).toBe('cancelled');
      expect(abortSession).toHaveBeenCalledWith(
        `${sessionId}:${runId}:analysis-source-enrichment`,
      );
      expect(session.sseEventBuffer.map((event: any) => event.eventType)).toEqual([
        'analysis_source_enrichment_cancelled',
        'end',
      ]);
    } finally {
      agentRoutesCancellationTestSeam.deleteSession(sessionId);
    }
  });

  it('persists terminal attribution when the runtime fails', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-runtime-failure-'));
    const app = makeApp();
    let sessionId: string | undefined;
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | undefined;
    try {
      const traceId = 'trace-runtime-failure';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
      process.env.SMARTPERFETTO_AI_ENABLED = 'true';

      await writeTraceMetadata({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        path: tracePath,
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      });

      const traceProcessorService = new TraceProcessorService(process.env.UPLOAD_DIR);
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockResolvedValue({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        filePath: tracePath,
        uploadTime: new Date(),
        status: 'ready',
      });
      jest.spyOn(traceProcessorService, 'ensureProcessorForLease')
        .mockResolvedValue(readyProcessor(traceId));
      jest.spyOn(traceProcessorService, 'runWithLease')
        .mockImplementation(async (_context, callback) => callback());
      setTraceProcessorServiceForTests(traceProcessorService);

      jest.spyOn(ClaudeRuntime.prototype, 'analyze')
        .mockRejectedValue(new Error('runtime failure canary'));
      jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession')
        .mockImplementation(() => undefined);

      const analyzeResponse = await analystHeaders(
        request(app).post('/api/agent/v1/analyze'),
      ).send({
        traceId,
        query: 'fail this analysis',
      });
      expect(analyzeResponse.status).toBe(200);
      sessionId = analyzeResponse.body.sessionId;
      const runId = analyzeResponse.body.runId;

      let statusResponse: request.Response | undefined;
      let manifest = getRunManifestStore().getByRunId(
        { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
        runId,
      );
      for (let attempt = 0; attempt < 50; attempt++) {
        statusResponse = await analystHeaders(
          request(app).get(`/api/agent/v1/${sessionId}/status`),
        );
        manifest = getRunManifestStore().getByRunId(
          { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
          runId,
        );
        if (statusResponse.body.status === 'failed' && manifest) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(statusResponse?.body).toEqual(expect.objectContaining({
        status: 'failed',
        error: 'runtime failure canary',
      }));
      expect(manifest).toEqual(expect.objectContaining({
        runId,
        turns: 0,
      }));
    } finally {
      if (sessionId) {
        await analystHeaders(request(app).delete(`/api/agent/v1/${sessionId}`));
        sessionContextManager.remove(sessionId);
      }
      leaseStore = getTraceProcessorLeaseStore();
      leaseStore.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, {recursive: true, force: true});
    }
  });

  it('does not start the runtime when its run is cancelled while lease startup is pending', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-lease-cancel-'));
    const app = makeApp();
    let sessionId: string | undefined;
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | undefined;
    let resolveLease: ((processor: TraceProcessor) => void) | undefined;
    let signalLeaseEntered: (() => void) | undefined;
    let resolveAbort: (() => void) | undefined;
    let signalAbortEntered: (() => void) | undefined;
    const leaseEntered = new Promise<void>((resolve) => {
      signalLeaseEntered = resolve;
    });
    const leaseReady = new Promise<TraceProcessor>((resolve) => {
      resolveLease = resolve;
    });
    const abortEntered = new Promise<void>((resolve) => {
      signalAbortEntered = resolve;
    });
    const abortReady = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });

    try {
      const traceId = 'trace-cancelled-during-lease-start';
      const tracePath = path.join(tmpDir, `${traceId}.trace`);
      await fs.writeFile(tracePath, 'trace bytes');
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
      process.env.SMARTPERFETTO_AI_ENABLED = 'true';

      await writeTraceMetadata({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        uploadedAt: new Date().toISOString(),
        status: 'ready',
        path: tracePath,
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      });

      const traceProcessorService = new TraceProcessorService(process.env.UPLOAD_DIR);
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockResolvedValue({
        id: traceId,
        filename: `${traceId}.trace`,
        size: 11,
        filePath: tracePath,
        uploadTime: new Date(),
        status: 'ready',
      });
      jest.spyOn(traceProcessorService, 'ensureProcessorForLease').mockImplementation(() => {
        if (!signalLeaseEntered) throw new Error('lease entry signal is unavailable');
        signalLeaseEntered();
        return leaseReady;
      });
      const runWithLeaseSpy = jest
        .spyOn(traceProcessorService, 'runWithLease')
        .mockImplementation(async (_context, callback) => callback());
      setTraceProcessorServiceForTests(traceProcessorService);

      const runtimeResult: AnalysisResult = {
        sessionId: 'should-not-run',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'should not run',
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
      };
      const analyzeSpy = jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockResolvedValue(runtimeResult);
      const abortSpy = jest.spyOn(ClaudeRuntime.prototype, 'abortSession').mockImplementation(() => {
        signalAbortEntered?.();
        return abortReady;
      });
      jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession').mockImplementation(() => undefined);

      const analyzePromise = analystHeaders(request(app).post('/api/agent/v1/analyze'))
        .send({ traceId, query: 'analyze after lease startup' })
        .then((response) => response);
      await leaseEntered;

      const scope = {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'analyst-user',
      };
      leaseStore = getTraceProcessorLeaseStore();
      const lease = leaseStore.listLeases(scope, { traceId })[0];
      const holder = lease?.holders[0];
      const metadataSessionId = holder?.metadata?.sessionId;
      const runId = holder?.holderRef;
      if (typeof metadataSessionId !== 'string') {
        throw new Error('agent lease did not expose its owning session');
      }
      if (typeof runId !== 'string') {
        throw new Error('agent lease did not expose its owning run');
      }
      sessionId = metadataSessionId;

      const missingRunResponse = await analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`));
      expect(missingRunResponse.status).toBe(400);
      expect(missingRunResponse.body).toEqual(
        expect.objectContaining({
          success: false,
          code: 'RUN_ID_REQUIRED',
        }),
      );
      expect(abortSpy).not.toHaveBeenCalled();

      const unknownRunResponse = await analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`)).send({
        runId: 'run-does-not-exist',
      });
      expect(unknownRunResponse.status).toBe(404);
      expect(unknownRunResponse.body).toEqual(
        expect.objectContaining({
          success: false,
          code: 'RUN_NOT_FOUND',
          runId: 'run-does-not-exist',
        }),
      );
      expect(abortSpy).not.toHaveBeenCalled();

      const cancelPromise = analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`))
        .send({ runId })
        .then((response) => response);
      await abortEntered;

      const nextRunDuringCancellation = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`),
      ).send({ traceId, query: 'must wait until cancellation settles' });
      expect(nextRunDuringCancellation.status).toBe(409);
      expect(nextRunDuringCancellation.body).toEqual(
        expect.objectContaining({
          code: 'CANCELLATION_IN_PROGRESS',
          runId,
        }),
      );
      expect(analyzeSpy).not.toHaveBeenCalled();

      resolveAbort?.();
      const cancelResponse = await cancelPromise;
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          runId,
          outcome: 'cancelled',
        }),
      );
      expect(abortSpy).toHaveBeenCalledTimes(1);
      expect(getRunManifestStore().getByRunId(
        { tenantId: 'tenant-a', workspaceId: 'workspace-a' },
        runId,
      )).toEqual(expect.objectContaining({
        runId,
        turns: 0,
      }));

      const nextRunAfterAbortBeforeLease = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`),
      ).send({ traceId, query: 'must still wait for lease startup to settle' });
      expect(nextRunAfterAbortBeforeLease.status).toBe(409);
      expect(nextRunAfterAbortBeforeLease.body).toEqual(
        expect.objectContaining({
          code: 'CANCELLATION_IN_PROGRESS',
          runId,
        }),
      );

      const repeatedCancelResponse = await analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`)).send({
        runId,
      });
      expect(repeatedCancelResponse.status).toBe(200);
      expect(repeatedCancelResponse.body).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          runId,
          outcome: 'already_cancelled',
        }),
      );
      expect(abortSpy).toHaveBeenCalledTimes(1);

      if (!resolveLease) throw new Error('lease resolver is unavailable');
      resolveLease(readyProcessor(traceId));

      const analyzeResponse = await analyzePromise;
      expect(analyzeResponse.status).toBe(200);
      expect(analyzeResponse.body.runId).toBe(runId);
      expect(analyzeSpy).not.toHaveBeenCalled();
      expect(runWithLeaseSpy).not.toHaveBeenCalled();

      const statusResponse = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.status).toBe('cancelled');
      expect(statusResponse.body.observability).toEqual(
        expect.objectContaining({
          runId,
          status: 'cancelled',
        }),
      );
    } finally {
      resolveAbort?.();
      resolveLease?.(readyProcessor('cleanup-cancelled-during-lease-start'));
      await new Promise((resolve) => setImmediate(resolve));
      if (sessionId) {
        await analystHeaders(request(app).delete(`/api/agent/v1/${sessionId}`));
        sessionContextManager.remove(sessionId);
      }
      leaseStore?.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not project a runtime success that arrives after the exact run was cancelled', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-late-success-'));
    const app = makeApp();
    let sessionId: string | undefined;
    let leaseStore: ReturnType<typeof getTraceProcessorLeaseStore> | undefined;
    let resolveAnalysis: ((result: AnalysisResult) => void) | undefined;
    let signalAnalysisEntered: (() => void) | undefined;
    let resolveAbort: (() => void) | undefined;
    let signalAbortEntered: (() => void) | undefined;
    const analysisEntered = new Promise<void>((resolve) => {
      signalAnalysisEntered = resolve;
    });
    const pendingAnalysis = new Promise<AnalysisResult>((resolve) => {
      resolveAnalysis = resolve;
    });
    const abortEntered = new Promise<void>((resolve) => {
      signalAbortEntered = resolve;
    });
    const abortReady = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });

    try {
      const traceId = 'trace-late-runtime-success';
      const referenceTraceId = 'trace-late-runtime-success-reference';
      delete process.env.SMARTPERFETTO_API_KEY;
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
      process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
      process.env[ENTERPRISE_DB_PATH_ENV] = path.join(tmpDir, 'enterprise.sqlite');
      process.env[ENTERPRISE_DATA_DIR_ENV] = path.join(tmpDir, 'data');
      process.env.UPLOAD_DIR = path.join(tmpDir, 'uploads');
      process.env.SMARTPERFETTO_AGENT_RUNTIME = 'claude-agent-sdk';
      process.env.SMARTPERFETTO_AI_ENABLED = 'true';

      for (const id of [traceId, referenceTraceId]) {
        const tracePath = path.join(tmpDir, `${id}.trace`);
        await fs.writeFile(tracePath, 'trace bytes');
        await writeTraceMetadata({
          id,
          filename: `${id}.trace`,
          size: 11,
          uploadedAt: new Date().toISOString(),
          status: 'ready',
          path: tracePath,
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'analyst-user',
        });
      }

      const traceProcessorService = new TraceProcessorService(process.env.UPLOAD_DIR);
      jest.spyOn(traceProcessorService, 'getOrLoadTrace').mockImplementation(async (id) => ({
        id,
        filename: `${id}.trace`,
        size: 11,
        filePath: path.join(tmpDir, `${id}.trace`),
        uploadTime: new Date(),
        status: 'ready',
      }));
      jest.spyOn(traceProcessorService, 'ensureProcessorForLease').mockImplementation(async (id) => readyProcessor(id));
      const runWithLeaseSpy = jest
        .spyOn(traceProcessorService, 'runWithLease')
        .mockImplementation(async (_context, callback) => callback());
      setTraceProcessorServiceForTests(traceProcessorService);

      const runtimeResult: AnalysisResult = {
        sessionId: 'late-runtime-success',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'must not be projected after cancellation',
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
      };
      jest.spyOn(ClaudeRuntime.prototype, 'analyze').mockImplementation(async () => {
        signalAnalysisEntered?.();
        return pendingAnalysis;
      });
      const abortSpy = jest.spyOn(ClaudeRuntime.prototype, 'abortSession').mockImplementation(() => {
        signalAbortEntered?.();
        return abortReady;
      });
      jest.spyOn(ClaudeRuntime.prototype, 'cleanupSession').mockImplementation(() => undefined);

      const analyzeResponse = await analystHeaders(request(app).post('/api/agent/v1/analyze')).send({
        traceId,
        referenceTraceId,
        query: 'resolve successfully after cancellation',
      });
      expect(analyzeResponse.status).toBe(200);
      sessionId = analyzeResponse.body.sessionId;
      const runId = analyzeResponse.body.runId;
      expect(typeof sessionId).toBe('string');
      expect(typeof runId).toBe('string');
      await analysisEntered;

      const cancelPromise = analystHeaders(request(app).post(`/api/agent/v1/${sessionId}/cancel`))
        .send({ runId })
        .then(response => response);
      await abortEntered;
      expect(abortSpy).toHaveBeenCalledTimes(1);

      resolveAnalysis?.(runtimeResult);
      await pendingAnalysis;
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      const nextRunBeforeAbortSettles = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`),
      ).send({
        traceId,
        referenceTraceId,
        query: 'must wait for cancellation cleanup to settle',
      });
      expect(nextRunBeforeAbortSettles.status).toBe(409);
      expect(nextRunBeforeAbortSettles.body).toEqual(
        expect.objectContaining({
          code: 'CANCELLATION_IN_PROGRESS',
          runId,
        }),
      );

      resolveAbort?.();
      const cancelResponse = await cancelPromise;
      expect(cancelResponse.status).toBe(200);
      expect(cancelResponse.body).toEqual(
        expect.objectContaining({
          status: 'cancelled',
          runId,
        }),
      );

      expect(runWithLeaseSpy).not.toHaveBeenCalled();
      const statusResponse = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/status`));
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.status).toBe('cancelled');
      expect(statusResponse.body.result).toBeUndefined();
      expect(getRunManifestStore().getByRunId(
        {tenantId: 'tenant-a', workspaceId: 'workspace-a'},
        runId,
      )).toEqual(expect.objectContaining({
        runId,
        turns: 0,
      }));

      const reportResponse = await analystHeaders(request(app).get(`/api/agent/v1/${sessionId}/report`));
      expect(reportResponse.status).not.toBe(200);

      const nextRunAfterSettle = await analystHeaders(
        request(app).post(`/api/agent/v1/sessions/${sessionId}/runs`),
      ).send({
        traceId,
        referenceTraceId,
        query: 'start after the cancelled runtime settled',
      });
      expect(nextRunAfterSettle.status).toBe(200);
      expect(nextRunAfterSettle.body.runId).not.toBe(runId);
    } finally {
      resolveAbort?.();
      resolveAnalysis?.({
        sessionId: 'cleanup-late-runtime-success',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'cleanup',
        confidence: 1,
        rounds: 1,
        totalDurationMs: 1,
      });
      await new Promise((resolve) => setImmediate(resolve));
      if (sessionId) {
        await analystHeaders(request(app).delete(`/api/agent/v1/${sessionId}`));
        sessionContextManager.remove(sessionId);
      }
      leaseStore = getTraceProcessorLeaseStore();
      leaseStore.close();
      setTraceProcessorLeaseStoreForTests(null);
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});


describe('HTTP shared finalization ownership', () => {
  function fixture(id: string) {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
    const runId = `${id}:run`;
    const run = {runId, requestId: `${id}:request`, sequence: 1, query: 'fact', startedAt: Date.now(), status: 'running'};
    const emitter = new EventEmitter();
    const native: AnalysisResult = {sessionId: id, success: false, conclusion: 'exact\r\nbody',
      findings: [], hypotheses: [], confidence: 0.2, rounds: 1, totalDurationMs: 1};
    const analyze = jest.fn(async (_query: string, _sessionId: string, _traceId: string,
      _options?: import('../../agent/core/orchestratorTypes').AnalysisOptions) => native);
    const orchestrator = Object.assign(emitter, {analyze, abortSession: jest.fn(), cleanupSession: jest.fn()});
    const session = {sessionId: id, traceId: 'trace-a', query: 'fact', createdAt: Date.now(), lastActivityAt: Date.now(),
      status: 'running', activeRun: run, lastRun: run, runRegistry: {[runId]: run}, runSequence: 1,
      sseClients: [], sseEventSeq: 0, sseEventBuffer: [], dataEnvelopes: [], hypotheses: [],
      conclusionHistory: [], conversationSteps: [], agentDialogue: [], agentResponses: [], orchestrator,
      logger: {info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), close: jest.fn(),
        timed: async <T>(_component: string, _label: string, operation: () => Promise<T>) => operation()},
    } as any;
    agentRoutesCancellationTestSeam.setSession(id, session);
    jest.spyOn(contextAuthorization, 'buildAnalysisContextAuthorizationFingerprint').mockReturnValue('fixed-auth');
    jest.spyOn(contextAuthorization, 'assertCurrentAnalysisContextAuthorization').mockImplementation(() => undefined);
    jest.spyOn(persistence, 'persistAgentTurn').mockImplementation(() => undefined);
    jest.spyOn(persistence, 'refreshPersistedAgentSnapshot').mockImplementation(() => undefined);
    const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [], overlayGeneration: 'http-finalizer'});
    const attach = (input: {evidenceAccess?: 'read_new' | 'existing_only'; unavailable?: boolean; deadlineMs?: number;
      runId?: string; referenceTraceId?: string; evidenceReadView?: EvidenceReadView} = {}) => {
      const ownedId = input.runId ?? runId;
      const candidate = {runId: ownedId, attemptId: 'attempt', candidateRef: 'candidate',
        conclusionFingerprint: analysisDeliveryFingerprint(native.conclusion)};
      attachFinalizationContext(native, {runId: ownedId, sessionId: id, deadlineMs: input.deadlineMs ?? Date.now() + 5000,
        strategyRegistry: registry, traceIdentity: {currentTraceId: 'trace-a', referenceTraceId: input.referenceTraceId},
        evidenceReadView: input.evidenceReadView,
        turnIntent: {schemaVersion: 1, status: input.unavailable ? 'unavailable' : 'resolved',
          source: input.unavailable ? 'fallback' : 'semantic', registryFingerprint: registry.registryFingerprint,
          taskKind: 'fact', sceneId: 'general', scope: 'scene_wide', recommendedComplexity: 'full',
          deliverable: 'answer', evidenceAccess: input.evidenceAccess ?? 'existing_only'},
        deliveryContext: {entry: 'runtime_draft', acceptedCandidate: candidate,
          completion: {...candidate, schemaVersion: 1, runtimeKind: 'openai-agents-sdk', status: 'completed'}, outputOrigin: 'sdk_final'},
      });
    };
    return {session, native, runId, analyze, orchestrator, attach};
  }

  it.each(['existing_only', 'unavailable', 'missing_context', 'expired'] as const)(
    'takes the exact result once and skips all hidden acquisition for %s', async mode => {
      const id = `http-native-${mode}`;
      const f = fixture(id);
      if (mode !== 'missing_context') f.attach({unavailable: mode === 'unavailable',
        evidenceAccess: mode === 'expired' ? 'read_new' : 'existing_only',
        deadlineMs: mode === 'expired' ? Date.now() - 1 : undefined});
      const raw = createDataEnvelope({columns: ['value'], rows: [[42]]},
        {type: 'sql_result', source: 'query', title: 'fact', evidenceRefId: 'data:http:raw'});
      f.analyze.mockImplementation(async () => {
        f.orchestrator.emit('update', {type: 'data', content: raw, timestamp: Date.now()});
        return f.native;
      });
      const summarySpy = jest.spyOn(summary, 'executeManagedTraceSummaryV1');
      const comparisonSpy = jest.spyOn(comparison, 'buildRawTraceComparisonReportSection');
      const sourceSpy = jest.spyOn(sourceSupplement, 'runAnalysisSourceSupplement');
      const query = jest.fn();
      const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
        expect(input.result).toBe(f.native);
        expect(takeFinalizationContext(f.native)).toBeUndefined();
        expect(input.owner.runId).toBe(f.runId);
        expect(input.comparisonIdentity).toBeUndefined();
        expect(input.dataEnvelopes).toContain(raw);
        expect(input.caseRetrieval).toEqual({status: 'not_checked', recommendations: []});
        input.owner.assertAuthorized();
        input.context?.dispose();
        return {result: input.result};
      });
      try {
        await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
          runContext: f.session.activeRun, traceProcessorService: {query}, executeStateTimeline: true,
          generateTracks: false,
        });
        expect(finalize).toHaveBeenCalledTimes(1);
        expect(f.analyze.mock.calls[0][3]?.runId).toBe(f.runId);
        expect(summarySpy).not.toHaveBeenCalled();
        expect(comparisonSpy).not.toHaveBeenCalled();
        expect(sourceSpy).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        expect(persistence.persistAgentTurn).toHaveBeenCalledWith(expect.objectContaining({result: f.native}));
        expect(f.session.result.conclusion).toBe('exact\r\nbody');
        expect(f.session.status).toBe('failed');
        const completedEvent = f.session.sseEventBuffer.find((event: any) => event.eventType === 'analysis_completed');
        expect(JSON.parse(completedEvent.eventData).data).toMatchObject({success: false, terminalRunStatus: 'failed'});
      } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
    });

  it.each(['captured', 'uncaptured', 'conflicting'] as const)(
    'passes %s comparison identities through the actual shared finalizer without new acquisition', async mode => {
      const id = `http-comparison-${mode}`;
      const f = fixture(id);
      const store = new ArtifactStore();
      const capturedIdentities: IdentityResolutionV1[] = [];
      const envelopes = (mode === 'conflicting' ? [1, 2, 3] : [1, 2]).map(upid => {
        const side = upid === 2 ? 'reference' : 'current';
        const traceId = side === 'current' ? 'trace-a' : 'trace-b';
        const identity: IdentityResolutionV1 = {version: 'identity_contract@1', identityRefId: `identity:${upid}`,
          status: 'verified', target: {traceId, traceSide: side, upid, source: 'skill_param'},
          processes: [{upid, packageName: `app.${side}`, confidence: 1, matchSources: ['upid']}], threads: [], warnings: []};
        const data = {columns: ['value'], rows: [[42]]};
        const envelope = createDataEnvelope(data, {type: 'skill_result', source: 'native', title: side,
          traceId, traceSide: side, evidenceRefId: `evidence:${upid}`, identityResolution: identity,
          scopeProvenance: {version: 'process_scope_evidence@1', entries: [{role: 'target', fields: ['value'],
            scope: {mode: 'exact_upid', traceId, traceSide: side, upid, identityRefId: identity.identityRefId}}]}});
        if (mode !== 'uncaptured') store.registerStandaloneEvidenceCapture(captureEvidenceTable(data), {
          meta: envelope.meta, display: envelope.display,
        });
        capturedIdentities.push(identity);
        // Transport metadata cannot replace the frozen native record.
        if (mode === 'captured') envelope.meta.identityResolution = {...identity, status: 'ambiguous', processes: []};
        return envelope;
      });
      f.attach({referenceTraceId: 'trace-b', evidenceReadView: store.createEvidenceReadView({ownerKey: f.runId,
        allowedTraces: [{traceId: 'trace-a', traceSide: 'current'}, {traceId: 'trace-b', traceSide: 'reference'}]})});
      f.analyze.mockImplementation(async () => {
        for (const envelope of envelopes) f.orchestrator.emit('update', {type: 'data', content: envelope, timestamp: Date.now()});
        return f.native;
      });
      const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult');
      const query = jest.fn();
      const comparisonSpy = jest.spyOn(comparison, 'buildRawTraceComparisonReportSection');
      try {
        await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'Compare', 'trace-a', {
          runContext: f.session.activeRun, referenceTraceId: 'trace-b', traceProcessorService: {query}, generateTracks: false,
        });
        expect(finalize).toHaveBeenCalledTimes(1);
        expect(f.session.result.deliveryAssurance.identity).toBe(mode === 'captured' ? 'passed' : 'not_checked');
        if (mode === 'captured') expect(f.session.result.identityResolutions).toEqual(capturedIdentities);
        expect(f.session.result.conclusion).toBe(f.native.conclusion);
        expect(query).not.toHaveBeenCalled();
        expect(comparisonSpy).not.toHaveBeenCalled();
      } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
    },
  );

  it('does not retire or delete a replacement session after authorization cleanup yields', async () => {
    const id = 'http-authorization-replacement'; const f = fixture(id); f.attach();
    const replacement = {...f.session, activeRun: {...f.session.activeRun, runId: 'replacement-run'}};
    const replacementOwner = agentRoutesCancellationTestSeam.createHttpFinalizationRun(
      replacement, 'replacement-run', {}, {}, 'fixed-auth',
    );
    f.orchestrator.cleanupSession.mockImplementation(() => {
      agentRoutesCancellationTestSeam.setSession(id, replacement);
      return Promise.resolve();
    });
    jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
      input.context?.dispose(); throw new contextAuthorization.AnalysisContextAuthorizationChangedError();
    });
    try {
      await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      });
      expect(replacementOwner.owner.isCurrent()).toBe(true);
      expect(replacement.status).toBe('running');
      expect(persistence.persistAgentTurn).not.toHaveBeenCalled();
    } finally {replacementOwner.release(); agentRoutesCancellationTestSeam.deleteSession(id);}
  });

  it('does not launch an automatic source supplement for a legacy deep_supplement activation', async () => {
    const id = 'http-no-automatic-source-supplement'; const f = fixture(id);
    f.native.success = true; f.attach({evidenceAccess: 'read_new'});
    f.session.sourceActivation = 'deep_supplement'; f.session.sourceAuthorization = {codeAwareMode: 'metadata_only', codebaseIds: ['source']};
    const supplement = jest.spyOn(sourceSupplement, 'runAnalysisSourceSupplement');
    jest.spyOn(reports, 'persistReport').mockImplementation(() => undefined);
    jest.spyOn(snapshots, 'persistCompletedAnalysisResultSnapshot').mockReturnValue(null);
    jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
      input.context?.dispose(); return {result: input.result};
    });
    try {
      await agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, '审查源码中的阻塞原因', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      });
      expect(supplement).not.toHaveBeenCalled();
      expect(f.session.analysisSourceEnrichment).toBeUndefined();
      expect(f.analyze).toHaveBeenCalledTimes(1);
    } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
  });

  it('takes and disposes context before an outer native-settlement callback cancels the run', async () => {
    const id = 'http-cancel-after-native';
    const f = fixture(id); f.attach();
    let taken: RuntimeFinalizationContext | undefined;
    const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult');
    f.session.logger.timed = async (_component: string, _label: string, operation: () => Promise<AnalysisResult>) => {
      const result = await operation();
      expect(takeFinalizationContext(result)).toBeUndefined();
      agentRoutesCancellationTestSeam.abortHttpFinalizationRuns(f.session, f.runId);
      return result;
    };
    try {
      await expect(agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      })).rejects.toMatchObject({name: 'AbortError'});
      expect(finalize).not.toHaveBeenCalled();
      expect(persistence.persistAgentTurn).not.toHaveBeenCalled();
      expect(f.session.result).toBeUndefined();
      expect(taken).toBeUndefined();
    } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
  });

  it('rejects a runtime context belonging to a different run without adopting its identity', async () => {
    const id = 'http-wrong-context';
    const f = fixture(id); f.attach({runId: 'runtime-other-run'});
    const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult');
    try {
      await expect(agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      })).rejects.toThrow('finalization_run_identity_mismatch');
      expect(finalize).not.toHaveBeenCalled();
      expect(persistence.persistAgentTurn).not.toHaveBeenCalled();
      expect(f.session.result).toBeUndefined();
    } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
  });

  it('keeps finalizer cancellation alive after native settlement and cannot commit a late result', async () => {
    const id = 'http-cancel-in-finalizer';
    const f = fixture(id); f.attach();
    let notifyStarted!: () => void;
    const started = new Promise<void>(resolve => {notifyStarted = resolve;});
    const finalize = jest.spyOn(finalization, 'finalizeAnalysisResult').mockImplementation(async input => {
      notifyStarted();
      try {await new Promise<never>((_resolve, reject) => {
        input.owner.signal.addEventListener('abort', () => reject(input.owner.signal.reason), {once: true});
      });} finally {input.context?.dispose();}
      return {result: input.result};
    });
    try {
      const pending = agentRoutesCancellationTestSeam.runAgentDrivenAnalysis(id, 'fact', 'trace-a', {
        runContext: f.session.activeRun, generateTracks: false,
      });
      await started;
      await agentRoutesCancellationTestSeam.cancelSessionRun(id, f.runId, 'cancel finalization');
      await pending;
      expect(finalize).toHaveBeenCalledTimes(1);
      expect(persistence.persistAgentTurn).not.toHaveBeenCalled();
      expect(f.session.result).toBeUndefined();
      expect(f.session.conclusionHistory).toEqual([]);
    } finally {agentRoutesCancellationTestSeam.deleteSession(id);}
  });
});
