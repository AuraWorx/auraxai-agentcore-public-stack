/** The file the docked preview pane is showing. */
export interface OpenFilePreviewRef {
  /** User-files upload id — the owner-scoped handle every route keys on. */
  uploadId: string;
  /** Display name, used for the pane header and the download filename. */
  filename: string;
}

/**
 * MIME type of a Word document (OOXML). Matches
 * `apis.shared.files.ALLOWED_MIME_TYPES` and the `_DOCX_MIME` constant in
 * `agents/builtin_tools/word_document_tool.py`.
 */
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * MIME type of a PowerPoint presentation (OOXML). Matches
 * `apis.shared.files.ALLOWED_MIME_TYPES` and the `_PPTX_MIME` constant in
 * `agents/builtin_tools/powerpoint_presentation_tool.py`.
 */
export const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/**
 * MIME type of a comma-separated values file. Matches the `.csv` entry
 * in `apis.shared.files.ALLOWED_EXTENSIONS`.
 */
export const CSV_MIME = 'text/csv';

/** What the pane knows how to render, and which viewer does it. */
export type PreviewKind = 'docx' | 'pptx' | 'csv';

/** Human label for the pane header's subtitle. */
export const PREVIEW_KIND_LABELS: Readonly<Record<PreviewKind, string>> = {
  docx: 'Word document',
  pptx: 'PowerPoint presentation',
  csv: 'Data file',
};

/**
 * The MIME types each viewer will accept, checked against what
 * `/preview-url` reports.
 *
 * A list rather than a single type because the recorded MIME is
 * whatever the *browser* reported at upload time (`request.mime_type`
 * in `files/service.py`), not something the server derives from the
 * bytes. For the OOXML formats that is reliably the one true type. For
 * `.csv` it is not: Windows reports `application/vnd.ms-excel` for a
 * `.csv` whenever Excel is the registered handler, and some clients
 * send `application/csv` or fall back to `text/plain`. Rejecting those
 * would fail the preview on the most ordinary desktop in the building,
 * for a file whose extension already told us what it is.
 */
export const PREVIEW_KIND_MIMES: Readonly<
  Record<PreviewKind, readonly string[]>
> = {
  docx: [DOCX_MIME],
  pptx: [PPTX_MIME],
  csv: [CSV_MIME, 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
};

/**
 * Which viewer a filename maps to, or null if the pane can't render it.
 *
 * Extension-based rather than MIME-based on purpose: the inline download
 * card is rendered from a persisted tool payload that carries only
 * `filename` and `upload_id` — the MIME type isn't in it, and asking the
 * server for one just to decide whether to show a button would put a
 * request behind every card. The authoritative MIME check still happens
 * in `FilePreviewHttpService.fetchDocument`, against what
 * `/preview-url` reports, so a mislabelled `.docx` fails there rather
 * than feeding garbage to the renderer.
 *
 * Legacy `.doc`, `.ppt` and `.xls` are deliberately excluded: they are
 * the pre-2007 binary formats, which neither the OOXML renderers nor
 * the delimited-text parser can read at all.
 *
 * `.xlsx` is deliberately absent, and for a narrower reason than it
 * looks. There is no client-side *renderer* for it we are willing to
 * ship: the npm build of SheetJS is frozen at a 2022 release carrying
 * unfixed advisories, and the only maintained grid renderer is built on
 * ExcelJS, which throws outright on the workbooks
 * `create_excel_spreadsheet` produces whenever one contains a native
 * chart. That rules out reading the bytes here — it does not rule out a
 * server-side read that hands this pane rows, which is the open path.
 * Until then, download-and-open remains it for `.xlsx`.
 */
export function previewKindFor(filename: string): PreviewKind | null {
  const name = filename.trim();
  if (/\.docx$/i.test(name)) return 'docx';
  if (/\.pptx$/i.test(name)) return 'pptx';
  if (/\.csv$/i.test(name)) return 'csv';
  return null;
}

/** Whether a filename is one the preview pane can render. */
export function isPreviewableFilename(filename: string): boolean {
  return previewKindFor(filename) !== null;
}
