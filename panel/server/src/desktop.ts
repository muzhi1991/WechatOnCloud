import type { Instance } from './store.js';

export type InstanceMode = 'app' | 'desktop';
export const instanceMode = (inst: Pick<Instance, 'mode'>): InstanceMode => inst.mode === 'desktop' ? 'desktop' : 'app';

export function desktopImage(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const image = env.WOC_DESKTOP_IMAGE?.trim();
  if (!image) return undefined;
  if (!/^sha256:[a-f0-9]{64}$/.test(image) && !/@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('WOC_DESKTOP_IMAGE must be pinned to an image ID or digest');
  }
  return image;
}

export function instanceImage(inst: Pick<Instance, 'mode' | 'cuaEnabled'>, appImage: string, cuaImage?: string, fullDesktopImage = desktopImage()): string {
  const image = instanceMode(inst) === 'desktop' ? fullDesktopImage : inst.cuaEnabled ? cuaImage : appImage;
  if (!image) throw new Error(instanceMode(inst) === 'desktop' ? '当前部署未配置完整桌面镜像' : '当前部署未配置 Cua 镜像');
  return image;
}

export function validateMode(mode: unknown, reuseVolume: unknown): InstanceMode {
  if (mode !== undefined && mode !== 'app' && mode !== 'desktop') throw new Error('实例模式必须为 app 或 desktop');
  if (mode === 'desktop' && reuseVolume) throw new Error('完整桌面首版仅支持新建空白数据卷，不能复用应用实例卷');
  return mode === 'desktop' ? 'desktop' : 'app';
}

export function assertDesktopImage(inst: Pick<Instance, 'mode'>, labels: Record<string, string> = {}) {
  if ((instanceMode(inst) === 'desktop') !== (labels['io.woc.desktop'] === '1')) {
    throw new Error('实例模式与镜像不匹配；应用实例和完整桌面实例不能互换镜像');
  }
}
