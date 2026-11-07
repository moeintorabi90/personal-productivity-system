/**
 * Hands an exported backup to the user without any network request: a normal download
 * (all platforms) or, where supported, the system share sheet (Android/iPhone: save to Files,
 * Drive, …). docs/BACKUP_FORMAT.md, "Export flow".
 */
function toFile(fileName: string, text: string): File {
  return new File([text], fileName, { type: "application/json" });
}

export function downloadBackup(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function canShareFiles(): boolean {
  try {
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [toFile("probe.json", "{}")] });
  } catch {
    return false;
  }
}

/**
 * "shared": the share sheet took the file. "cancelled": the user closed the sheet.
 * "refused": the browser would not share it (NotAllowedError), so the caller saves it as a
 * download instead. Android Chrome refuses every file named `.json` although `canShare`
 * returns true (seen on Android Chrome); renaming the file is not an option, since the backup
 * name and its `.json` extension are part of the format (BACKUP_FORMAT.md).
 */
export type ShareOutcome = "shared" | "cancelled" | "refused";

export async function shareBackup(fileName: string, text: string): Promise<ShareOutcome> {
  try {
    await navigator.share({ files: [toFile(fileName, text)], title: fileName });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    if (error instanceof DOMException && error.name === "NotAllowedError") return "refused";
    throw error;
  }
}

/** Reads a picked file's bytes (File.arrayBuffer with a FileReader fallback for older engines). */
export function readFileBytes(file: File): { size: number; arrayBuffer(): Promise<ArrayBuffer> } {
  return {
    size: file.size,
    arrayBuffer: () =>
      typeof file.arrayBuffer === "function"
        ? file.arrayBuffer()
        : new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
          }),
  };
}
