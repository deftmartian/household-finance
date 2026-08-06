import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

export class ActualApiDataDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActualApiDataDirectoryError';
  }
}

/**
 * Actual's API expects dataDir to exist. Prepare only the exact configured
 * directory, then reject symlinks, unexpected ownership, or permissive modes
 * before the API can read or write budget data.
 */
export async function ensurePrivateActualApiDataDirectory(
  dataDirectory: string,
): Promise<void> {
  if (
    !isAbsolute(dataDirectory) ||
    resolve(dataDirectory) === '/' ||
    dataDirectory !== dataDirectory.trim()
  ) {
    throw new ActualApiDataDirectoryError(
      'Actual API data directory must be a non-root absolute path without surrounding whitespace',
    );
  }

  const resolvedDirectory = resolve(dataDirectory);
  await mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });

  const [canonicalDirectory, metadata] = await Promise.all([
    realpath(resolvedDirectory),
    lstat(resolvedDirectory),
  ]);
  if (
    canonicalDirectory !== resolvedDirectory ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory()
  ) {
    throw new ActualApiDataDirectoryError(
      'Actual API data directory must be a real directory without symlink components',
    );
  }

  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId !== undefined && metadata.uid !== effectiveUserId) {
    throw new ActualApiDataDirectoryError(
      'Actual API data directory must be owned by the runtime user',
    );
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    throw new ActualApiDataDirectoryError(
      'Actual API data directory permissions must be 0700',
    );
  }
}
