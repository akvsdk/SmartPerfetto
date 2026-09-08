// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

const nativeObjectConstructorSource = Function.prototype.toString.call(Object);

/** Recognize ordinary objects across realms without reading a constructor getter. */
export function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  if (Object.getPrototypeOf(prototype) !== null) return false;
  const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
  if (!constructor || !('value' in constructor) || typeof constructor.value !== 'function') return false;
  const constructorPrototype = Object.getOwnPropertyDescriptor(constructor.value, 'prototype');
  return Boolean(constructorPrototype && 'value' in constructorPrototype && constructorPrototype.value === prototype &&
    Function.prototype.toString.call(constructor.value) === nativeObjectConstructorSource);
}
