/** Why a backup file was refused. The UI maps each code to a translated, user-safe message. */
export type BackupErrorCode =
  | "FILE_TOO_LARGE"
  | "INVALID_UTF8"
  | "INVALID_STRUCTURE"
  | "INVALID_JSON"
  | "NOT_A_BACKUP"
  | "NEWER_VERSION"
  | "INVALID_HEADER"
  | "DAMAGED"
  | "PASSWORD_REQUIRED"
  | "WRONG_PASSWORD"
  | "INVALID_PAYLOAD"
  | "UNKNOWN_RECORD_TYPE"
  | "EXCLUDED_DATA"
  | "UNRESOLVED_REFERENCE"
  | "LIMIT_EXCEEDED"
  | "EXPORT_TOO_LARGE"
  | "EXPORT_VERIFICATION_FAILED";

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  readonly detail: string | undefined;

  constructor(code: BackupErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BackupError";
    this.code = code;
    this.detail = detail;
  }
}
