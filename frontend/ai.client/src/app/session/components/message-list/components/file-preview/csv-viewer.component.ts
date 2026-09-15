import {
  CdkVirtualScrollViewport,
  ScrollingModule,
} from '@angular/cdk/scrolling';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CsvParseError, CsvTable, parseCsv } from '../../../../services/file-preview/csv-parse';

/**
 * Height of one body row, in CSS px.
 *
 * Load-bearing: `cdk-virtual-scroll-viewport`'s fixed-size strategy
 * computes the spacer height and the rendered window from this number,
 * so a row that paints taller than it claims leaves the rows drifting
 * out of the viewport as you scroll. Keep it in step with the row's
 * `h-8` and the cell padding below.
 */
const ROW_HEIGHT_PX = 32;

/** Column width bounds, in CSS px. */
const COL_MIN_PX = 88;
const COL_MAX_PX = 320;

/** Approximate px per character at the grid's text size, for sizing
 *  columns without laying anything out first. */
const PX_PER_CHAR = 7.5;

/** Rows sampled when measuring a column's natural width. Measuring all
 *  of them would walk 50k rows to move a column by a few px. */
const WIDTH_SAMPLE_ROWS = 100;

/**
 * Renders a delimited data file (`.csv`, `.tsv`) as a scrollable grid.
 *
 * Deliberately a *data* view and not a spreadsheet view. Cells are the
 * strings the file contained, rendered left-aligned and unformatted:
 * there is no type inference, no locale-aware number rendering and no
 * date parsing, because the user is previewing what the file will hand
 * to whatever reads it next, and a preview that prettifies `007` into
 * `7` is answering a different question than the one being asked.
 *
 * Virtualised with `cdk-virtual-scroll-viewport` rather than capped at a
 * few hundred rows. `@angular/cdk` is already a dependency (dialog,
 * menu, overlay, a11y), uniform row height is the fixed-size strategy's
 * best case, and the alternative — "showing the first 500 rows of
 * 40,000" — is the difference between previewing a file and previewing
 * the top of one. The parse caps in `csv-parse.ts` still apply; they
 * bound the backing array, while this bounds the DOM.
 *
 * The cost of virtualising is that the grid cannot be a `<table>`: the
 * viewport needs to own the scroll container and transform its content,
 * which `<tbody>` will not tolerate. So it is a div grid carrying
 * explicit ARIA grid roles, with `aria-rowcount` and `aria-rowindex`
 * reporting the true size of the data rather than the size of the
 * rendered window.
 */
@Component({
  selector: 'app-csv-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ScrollingModule],
  template: `
    @if (table(); as data) {
      <div
        class="flex h-full flex-col bg-white dark:bg-gray-900"
        role="grid"
        [attr.aria-rowcount]="data.rows.length + 1"
        [attr.aria-colcount]="data.headers.length"
        [attr.aria-label]="'Data preview, ' + data.rows.length + ' rows'"
        [style.--csv-cols]="gridTemplate()"
      >
        <!--
          The header sits outside the viewport because a sticky row
          inside a transformed virtual-scroll container does not stay
          put. Its horizontal offset is mirrored from the viewport's
          scroll instead — one-way, since the header itself does not
          scroll.
        -->
        <div #headerScroller class="overflow-hidden border-b border-gray-200 dark:border-gray-700">
          <div
            class="csv-row bg-gray-50 dark:bg-gray-800"
            role="row"
            aria-rowindex="1"
          >
            <div
              class="csv-gutter text-gray-500 dark:text-gray-400"
              role="columnheader"
              aria-label="Row number"
            >
              <span aria-hidden="true">#</span>
            </div>
            @for (header of data.headers; track $index) {
              <div
                class="csv-cell font-semibold text-gray-900 dark:text-gray-100"
                role="columnheader"
                [attr.aria-colindex]="$index + 2"
                [title]="header"
              >
                {{ header }}
              </div>
            }
          </div>
        </div>

        @if (data.rows.length === 0) {
          <p class="px-4 py-6 text-sm text-gray-500 dark:text-gray-400">
            This file has column headers but no data rows.
          </p>
        } @else {
          <cdk-virtual-scroll-viewport [itemSize]="rowHeight" class="min-h-0 flex-1">
            <div
              *cdkVirtualFor="let row of data.rows; let i = index; trackBy: trackByIndex"
              class="csv-row border-b border-gray-100 hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/50"
              role="row"
              [attr.aria-rowindex]="i + 2"
            >
              <div
                class="csv-gutter text-gray-500 dark:text-gray-400"
                role="rowheader"
              >
                {{ i + 1 }}
              </div>
              @for (cell of row; track $index) {
                <div
                  class="csv-cell text-gray-700 dark:text-gray-300"
                  role="gridcell"
                  [attr.aria-colindex]="$index + 2"
                  [title]="cell"
                >
                  {{ cell }}
                </div>
              }
            </div>
          </cdk-virtual-scroll-viewport>
        }

        <footer
          class="flex items-center gap-2 border-t border-gray-200 px-4 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
        >
          <span>{{ summary() }}</span>
          @if (data.truncated) {
            <span class="text-state-warning-600 dark:text-state-warning-400">
              {{ truncationNotice() }}
            </span>
          }
        </footer>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
    }

    /* Header and body rows share one track list so the columns line up
       without measuring anything after layout. */
    .csv-row {
      display: grid;
      grid-template-columns: var(--csv-cols);
      align-items: center;
      height: 32px;
      width: max-content;
      min-width: 100%;
    }

    .csv-cell,
    .csv-gutter {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-inline: 0.75rem;
      font-size: 0.8125rem;
      line-height: 1.25rem;
      font-variant-numeric: tabular-nums;
    }

    /* Colour deliberately lives on the elements, as the utility pair
       text-gray-500 / dark:text-gray-400, rather than here. There is no
       single neutral step that clears WCAG AA against both surfaces:
       gray-400 measures 2.6:1 on the light grid, and gray-500 is the
       step the surface generator itself reports as short of AA against
       the dark one. (No backticks in this block - one inside a styles
       template literal breaks the Angular compiler while tsc passes.) */
    .csv-gutter {
      text-align: right;
      padding-inline: 0.5rem;
      font-size: 0.6875rem;
      user-select: none;
    }

    /* The viewport is the horizontal scroller as well as the vertical
       one, so rows wider than the rail can be reached. */
    cdk-virtual-scroll-viewport {
      overflow-x: auto;
    }
  `,
})
export class CsvViewerComponent {
  readonly bytes = input<ArrayBuffer | null>(null);

  /** Emitted once a grid is on screen, so the pane drops its skeleton. */
  readonly rendered = output<void>();
  /** Emitted with a user-facing message when the file cannot be read. */
  readonly renderFailed = output<string>();

  protected readonly rowHeight = ROW_HEIGHT_PX;
  protected readonly table = signal<CsvTable | null>(null);

  private readonly headerScroller =
    viewChild<ElementRef<HTMLElement>>('headerScroller');
  private readonly viewport = viewChild(CdkVirtualScrollViewport);

  /** One `grid-template-columns` track list, shared by the header row
   *  and every body row. */
  protected readonly gridTemplate = computed(() => {
    const data = this.table();
    if (!data) return '';
    const gutter = `${gutterWidthFor(data.rows.length)}px`;
    const columns = data.headers.map((header, i) =>
      `${measureColumn(header, data.rows, i)}px`,
    );
    return [gutter, ...columns].join(' ');
  });

  protected readonly summary = computed(() => {
    const data = this.table();
    if (!data) return '';
    const rows = data.rows.length;
    const cols = data.headers.length;
    return `${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'} · ${cols} ${
      cols === 1 ? 'column' : 'columns'
    } · ${DELIMITER_LABELS[data.delimiter]}`;
  });

  protected readonly truncationNotice = computed(() => {
    const by = this.table()?.truncatedBy;
    switch (by) {
      case 'bytes':
        return '· preview stops partway through a large file';
      case 'rows':
        return '· later rows not shown';
      case 'columns':
        return '· later columns not shown';
      default:
        return '';
    }
  });

  constructor() {
    effect(() => {
      const bytes = this.bytes();
      if (!bytes) {
        this.table.set(null);
        return;
      }

      try {
        this.table.set(parseCsv(bytes));
      } catch (e) {
        this.table.set(null);
        this.renderFailed.emit(
          e instanceof CsvParseError
            ? e.message
            : "This file couldn't be read as delimited text.",
        );
        return;
      }

      this.rendered.emit();
    });

    effect((onCleanup) => {
      const viewport = this.viewport();
      if (!viewport) return;
      const sub = viewport.elementScrolled().subscribe(() => {
        this.syncHeaderScroll();
      });
      onCleanup(() => sub.unsubscribe());
    });
  }

  /** `trackBy` on the row index rather than the row: a data file may
   *  legitimately repeat identical rows, and identity tracking would
   *  make the virtual scroller reuse the wrong one. */
  protected trackByIndex(index: number): number {
    return index;
  }

  /**
   * Mirror the viewport's horizontal offset onto the header.
   *
   * Driven by `elementScrolled()` rather than a template `(scroll)`
   * binding or `(scrolledIndexChange)`. `scrolledIndexChange` is the
   * wrong signal outright — it fires when the first *rendered row*
   * changes, so it never fires for a purely horizontal scroll and the
   * header stays behind while the body moves. `elementScrolled()` emits
   * for both axes, and CDK's scroll dispatcher already runs it outside
   * the Angular zone; since the handler only writes `scrollLeft` on a
   * DOM node and touches no signal, the sync costs no change detection
   * at scroll rate.
   */
  private syncHeaderScroll(): void {
    const header = this.headerScroller()?.nativeElement;
    const viewport = this.viewport();
    if (header && viewport) {
      header.scrollLeft = viewport.measureScrollOffset('left');
    }
  }
}

const DELIMITER_LABELS: Readonly<Record<string, string>> = {
  ',': 'comma-separated',
  '\t': 'tab-separated',
  ';': 'semicolon-separated',
  '|': 'pipe-separated',
};

/** Enough room for the largest row number the gutter will show. */
function gutterWidthFor(rowCount: number): number {
  return Math.max(40, String(rowCount).length * 8 + 16);
}

/**
 * Width for one column, from the longest value in a sample of its cells.
 *
 * Approximated from character counts rather than measured, because
 * measuring means laying out every cell before the first paint. The
 * clamp matters more than the estimate: a column of long free text stops
 * at `COL_MAX_PX` and ellipsises (the full value is on the cell's
 * `title`), and a column of short codes still gets a readable minimum.
 */
function measureColumn(
  header: string,
  rows: readonly string[][],
  index: number,
): number {
  let longest = header.length;
  const sampled = Math.min(rows.length, WIDTH_SAMPLE_ROWS);
  for (let i = 0; i < sampled; i++) {
    const cell = rows[i][index];
    if (cell && cell.length > longest) longest = cell.length;
  }
  return Math.min(
    COL_MAX_PX,
    Math.max(COL_MIN_PX, Math.round(longest * PX_PER_CHAR) + 24),
  );
}
