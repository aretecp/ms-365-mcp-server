import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomically replace `targetPath` with `contents`. Writes to a sibling
 * `.<basename>.<pid>.<timestamp>.tmp`, fsyncs the data, then renames over
 * the target. The rename is atomic on POSIX filesystems; readers see
 * either the old or the new contents, never a partial write.
 *
 * `mode` defaults to 0o600 since policy files may include UPNs that
 * shouldn't be world-readable.
 */
export function atomicWriteSync(targetPath: string, contents: string, mode: number = 0o600): void {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmpPath, 'wx', mode);
  try {
    fs.writeSync(fd, contents, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, targetPath);
}
