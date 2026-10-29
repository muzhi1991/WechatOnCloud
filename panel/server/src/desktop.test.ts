import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instanceMode, instanceImage, desktopImage, validateMode, assertDesktopImage } from './desktop.js';
const digest = 'sha256:' + 'a'.repeat(64);
test('legacy instances keep the application image; Cua opt-in keeps the existing derived image', () => {
  assert.equal(instanceMode({}), 'app');
  assert.equal(instanceImage({}, 'app', 'cua', digest), 'app');
  assert.equal(instanceImage({ cuaEnabled: true }, 'app', 'cua', digest), 'cua');
});
test('desktop selection cannot silently fall back to an application image', () => {
  assert.equal(instanceImage({ mode: 'desktop', cuaEnabled: true }, 'app', 'cua', digest), digest);
  assert.throws(() => instanceImage({ mode: 'desktop' }, 'app', 'cua', ''), /完整桌面镜像/);
  assert.throws(() => desktopImage({ WOC_DESKTOP_IMAGE: 'local/desktop:latest' }), /pinned/);
  assert.equal(desktopImage({ WOC_DESKTOP_IMAGE: digest }), digest);
});
test('creation validates mode and rejects application-volume migration', () => {
  assert.equal(validateMode(undefined, 'woc-data-old'), 'app');
  assert.equal(validateMode('desktop', undefined), 'desktop');
  assert.throws(() => validateMode('desktop', 'woc-data-old'), /不能复用/);
  assert.throws(() => validateMode('other', undefined), /实例模式/);
});
test('rebuild and rollback reject mismatched desktop/application artifacts before deletion', () => {
  assert.doesNotThrow(() => assertDesktopImage({}, {}));
  assert.doesNotThrow(() => assertDesktopImage({ mode: 'desktop' }, { 'io.woc.desktop': '1' }));
  assert.throws(() => assertDesktopImage({}, { 'io.woc.desktop': '1' }), /不能互换镜像/);
  assert.throws(() => assertDesktopImage({ mode: 'desktop' }, {}), /不能互换镜像/);
});
