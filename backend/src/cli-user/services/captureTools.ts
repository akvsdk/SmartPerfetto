// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
import type { CaptureToolResolution } from '../types';

export interface CaptureToolResolverOptions {
  backendRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export function detectHostPlatformKey(): string | undefined {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64';
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64';
  return undefined;
}

export function resolveAdbTool(opts: CaptureToolResolverOptions = {}): CaptureToolResolution {
  const env = opts.env ?? process.env;
  const platformKey = detectHostPlatformKey();
  const executableName = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const envPath = env.ADB_PATH?.trim();
  if (envPath) {
    return buildResolution({
      name: 'adb',
      source: 'env',
      path: path.resolve(envPath),
      platformKey,
      hint: 'ADB_PATH is set but does not point to an executable adb binary.',
    });
  }

  if (platformKey) {
    const bundledPath = path.join(
      opts.backendRoot ?? process.cwd(),
      'prebuilts',
      'android-platform-tools',
      platformKey,
      executableName,
    );
    const bundled = buildResolution({
      name: 'adb',
      source: 'bundled',
      path: bundledPath,
      platformKey,
      hint: 'Bundled ADB is not installed in this package. Set ADB_PATH or put adb on PATH.',
    });
    if (bundled.exists && bundled.executable) return bundled;
  }

  return buildPathResolution({
    name: 'adb',
    executableName,
    platformKey,
    hint: 'adb was not found. Set ADB_PATH or install Android SDK Platform-Tools.',
  });
}

export function resolveTraceboxTool(
  overridePath?: string,
  platformKey = detectHostPlatformKey(),
  opts: CaptureToolResolverOptions = {},
): CaptureToolResolution {
  const executableName = platformKey?.startsWith('win32') ? 'tracebox.exe' : 'tracebox';
  if (overridePath?.trim()) {
    return buildResolution({
      name: 'tracebox',
      source: 'override',
      path: path.resolve(overridePath),
      platformKey,
      hint: '--tracebox does not point to an executable tracebox binary.',
    });
  }

  if (platformKey) {
    return buildResolution({
      name: 'tracebox',
      source: 'bundled',
      path: path.join(
        opts.backendRoot ?? process.cwd(),
        'prebuilts',
        'perfetto-recording-tools',
        platformKey,
        executableName,
      ),
      platformKey,
      hint: [
        'No approved bundled tracebox binary is available for this platform.',
        'Use --tracebox /path/to/tracebox, or capture on Android Q/API 29+ without --sideload.',
      ].join(' '),
    });
  }

  return {
    name: 'tracebox',
    source: 'missing',
    path: executableName,
    exists: false,
    executable: false,
    hint: 'Unsupported host platform for bundled tracebox. Use --tracebox /path/to/tracebox.',
  };
}

export function androidTraceboxPlatformKey(abi: string): string | undefined {
  switch (abi) {
    case 'arm64-v8a':
      return 'android-arm64';
    case 'armeabi-v7a':
    case 'armeabi':
      return 'android-arm';
    case 'x86_64':
      return 'android-x64';
    case 'x86':
      return 'android-x86';
    default:
      return undefined;
  }
}

export function assertToolUsable(tool: CaptureToolResolution): void {
  if (tool.exists && tool.executable) {
    if (tool.name === 'tracebox' && tool.source === 'bundled') {
      assertBundledTraceboxSha(tool);
    }
    return;
  }
  throw new Error(`${tool.name} is not available at ${tool.path}. ${tool.hint ?? ''}`.trim());
}

function assertBundledTraceboxSha(tool: CaptureToolResolution): void {
  const platformKey = tool.platformKey;
  const pinKey = platformKey ? traceboxShaKey(platformKey) : undefined;
  const pinFile = findRecordingToolsPinFile();
  if (!pinKey || !pinFile) {
    throw new Error(`bundled tracebox exists but no SHA256 pin can be resolved for ${platformKey ?? 'unknown-platform'}`);
  }
  const pins = parseEnvFile(pinFile);
  const expected = pins[pinKey]?.trim();
  if (!expected) {
    throw new Error(`bundled tracebox exists but ${pinKey} is empty in ${pinFile}`);
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(tool.path)).digest('hex');
  if (actual !== expected) {
    throw new Error(`bundled tracebox failed SHA256 verification: expected ${expected}, got ${actual}`);
  }
}

function traceboxShaKey(platformKey: string): string | undefined {
  switch (platformKey) {
    case 'linux-x64':
      return 'PERFETTO_TRACEBOX_SHA256_LINUX_X64';
    case 'linux-arm64':
      return 'PERFETTO_TRACEBOX_SHA256_LINUX_ARM64';
    case 'darwin-arm64':
      return 'PERFETTO_TRACEBOX_SHA256_DARWIN_ARM64';
    case 'darwin-x64':
      return 'PERFETTO_TRACEBOX_SHA256_DARWIN_X64';
    case 'android-arm64':
      return 'PERFETTO_TRACEBOX_SHA256_ANDROID_ARM64';
    case 'android-arm':
      return 'PERFETTO_TRACEBOX_SHA256_ANDROID_ARM';
    case 'android-x64':
      return 'PERFETTO_TRACEBOX_SHA256_ANDROID_X64';
    case 'android-x86':
      return 'PERFETTO_TRACEBOX_SHA256_ANDROID_X86';
    default:
      return undefined;
  }
}

function findRecordingToolsPinFile(): string | undefined {
  const candidates = [
    path.join(process.cwd(), 'dist', 'perfetto-recording-tools-pin.env'),
    path.resolve(process.cwd(), '..', 'scripts', 'perfetto-recording-tools-pin.env'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function parseEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    values[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return values;
}

interface BuildResolutionInput {
  name: CaptureToolResolution['name'];
  source: CaptureToolResolution['source'];
  path: string;
  platformKey?: string;
  hint?: string;
}

function buildResolution(input: BuildResolutionInput): CaptureToolResolution {
  const exists = fs.existsSync(input.path);
  const executable = exists && isExecutable(input.path);
  return {
    name: input.name,
    // Where the tool *is*, not where it was looked for. Reporting the intended
    // source for a file that is not there made `doctor` contradict itself
    // inside one payload: `source: "bundled"` beside `exists: false`, under a
    // message reading "tracebox is not bundled". `path` still records where it
    // was expected. `buildPathResolution` already resolved this the same way.
    source: exists ? input.source : 'missing',
    path: input.path,
    exists,
    executable,
    platformKey: input.platformKey,
    // A hint is remediation advice, so it belongs to a failure. Attached
    // unconditionally it told users "adb was not found" next to
    // `exists: true, executable: true`.
    ...(executable ? {} : {hint: input.hint}),
  };
}

function buildPathResolution(input: {
  name: CaptureToolResolution['name'];
  executableName: string;
  platformKey?: string;
  hint?: string;
}): CaptureToolResolution {
  const probe = spawnSync(input.executableName, ['version'], {
    encoding: 'utf-8',
    timeout: 3000,
    stdio: 'ignore',
  });
  const usable = !probe.error && probe.status === 0;
  return {
    name: input.name,
    source: usable ? 'path' : 'missing',
    path: input.executableName,
    exists: usable,
    executable: usable,
    platformKey: input.platformKey,
    ...(usable ? {} : {hint: input.hint}),
  };
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
