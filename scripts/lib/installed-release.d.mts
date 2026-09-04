export const INSTALLED_MANIFEST: string;
export function digest(bytes: Uint8Array): string;
export function gitBlob(bytes: Uint8Array): string;
export function safeRelative(value: string): string;
export function isWithin(root: string, target: string): boolean;
export function assertPlainRoot(root: string): Promise<string>;
export function inventoryRelease(root: string): Promise<Array<Record<string, unknown>>>;
export function verifyInstalledRelease(root: string, expectedManifestSha256?: string): Promise<{
  manifest: { productVersion: string; sourceCommit: string; sourceTree: string; builtAt: string; [key:string]: unknown };
  entries: Array<{path:string;mode:string;type:'blob';sha:string}>;
  build: {productVersion:string;commitSha:string;builtAt:string;[key:string]:unknown};
}>;
