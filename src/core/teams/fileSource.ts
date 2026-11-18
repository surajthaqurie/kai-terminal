import fs from "node:fs";
import { IntegrationError } from "../integrations/types";
import type { UploadSource } from "./graph";

/**
 * An upload source that reads a file from disk one stretch at a time, so a large file is never
 * held in memory whole: an upload keeps at most one chunk of it. The file is opened for each
 * stretch and closed again, so nothing stays open between chunks (or when an upload is abandoned).
 * A file that was deleted, moved or truncated after it was attached shows up as an error on the
 * stretch that can no longer be read, which the upload turns into a clear message.
 */
export function fileUploadSource(filePath: string, size: number): UploadSource {
  return {
    size,
    async read(start, end) {
      const wanted = end - start;
      const buffer = Buffer.allocUnsafe(wanted);
      let handle: fs.promises.FileHandle | undefined;
      try {
        handle = await fs.promises.open(filePath, "r");
        let got = 0;
        while (got < wanted) {
          const { bytesRead } = await handle.read(buffer, got, wanted - got, start + got);
          if (bytesRead === 0) break; // the file is shorter than it was
          got += bytesRead;
        }
        return buffer.subarray(0, got);
      } catch {
        throw new IntegrationError(
          "bad_request",
          "The file could not be read while uploading it. It may have been moved or deleted.",
          "Attach it again and send it."
        );
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
  };
}
