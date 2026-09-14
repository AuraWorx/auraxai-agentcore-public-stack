import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroArrowRight,
  heroCheck,
  heroChevronLeft,
  heroChevronRight,
  heroPencil,
  heroQuestionMarkCircle,
} from '@ng-icons/heroicons/outline';
import {
  UserQuestionAnswer,
  UserQuestionRequest,
  UserQuestionService,
} from '../../../../../services/user-question/user-question.service';
import { SpinnerComponent } from '../../../../../components/spinner/spinner.component';

/**
 * Inline picker for the clarifying questions the agent paused its turn to ask.
 *
 * Visual language follows its sibling `ToolApprovalPromptComponent` — the 2px
 * primary-500 left accent, the shared `.action-btn`, the lift-on-mount
 * animation — so a paused turn looks the same whatever paused it.
 *
 * **One question at a time, with a pager.** Measured against real models, both
 * Haiku 4.5 and Sonnet 4.6 routinely ask three or four questions in a single
 * call, so rendering them stacked would drop a wall of radio groups into the
 * transcript. The pager keeps the prompt the size of a message bubble and lets
 * the user move at their own pace; answers accumulate locally and post once.
 *
 * **The picker owns "Other" and "Skip".** The backend strips any model-supplied
 * lookalike (a supplied "Other" carries no free-text field, so selecting it
 * would record a bare string that teaches the model nothing), which is why they
 * are added here rather than rendered from `options`.
 */
@Component({
  selector: 'app-user-question-prompt',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, FormsModule, SpinnerComponent],
  providers: [
    provideIcons({
      heroArrowRight,
      heroCheck,
      heroChevronLeft,
      heroChevronRight,
      heroPencil,
      heroQuestionMarkCircle,
    }),
  ],
  host: { class: 'block' },
  template: `
    <div
      class="question-prompt group relative w-full max-w-xl overflow-hidden rounded-lg border border-gray-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-white/10 dark:bg-slate-800/70"
      role="group"
      [attr.aria-label]="'Clarifying question ' + (index() + 1) + ' of ' + total()"
    >
      <span
        class="absolute inset-y-0 left-0 w-[2px] bg-primary-500 dark:bg-primary-400"
        aria-hidden="true"
      ></span>

      <!-- Header: question text + pager -->
      <div class="flex items-start gap-2.5 py-2 pr-2 pl-3">
        <!-- The colour lives on this wrapper, not on the ng-icon element:
             utility classes set directly on ng-icon do not take (measured in
             the browser — even text-gray-700 and size-5 were ignored, leaving
             the glyph on the inherited near-white at 1.10 contrast against
             this circle). The icon inherits currentColor from here instead,
             which lands the sanctioned bg-gray-100 / text-primary-accessible
             pairing at 9.63. -->
        <div
          class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-gray-100 text-primary-accessible ring-1 ring-gray-200/70 dark:bg-gray-700 dark:text-primary-50 dark:ring-white/10"
        >
          <ng-icon name="heroQuestionMarkCircle" aria-hidden="true" />
        </div>

        <div class="min-w-0 flex-1">
          <p
            class="text-[10px] leading-none font-semibold uppercase tracking-[0.08em] text-primary-600 dark:text-primary-300"
          >
            {{ current().header }}
          </p>
          <p class="mt-1 text-xs/5 text-gray-900 dark:text-gray-100">
            {{ current().question }}
          </p>
        </div>

        @if (total() > 1) {
          <div class="flex shrink-0 items-center gap-0.5 pt-0.5">
            <button
              type="button"
              class="pager-btn"
              (click)="back()"
              [disabled]="index() === 0 || resolving()"
              aria-label="Previous question"
            >
              <ng-icon name="heroChevronLeft" class="size-3.5" aria-hidden="true" />
            </button>
            <span
              class="px-1 text-[11px] tabular-nums text-gray-600 dark:text-gray-300"
              aria-live="polite"
            >
              {{ index() + 1 }} of {{ total() }}
            </span>
            <button
              type="button"
              class="pager-btn"
              (click)="next()"
              [disabled]="index() === total() - 1 || resolving()"
              aria-label="Next question"
            >
              <ng-icon name="heroChevronRight" class="size-3.5" aria-hidden="true" />
            </button>
          </div>
        }
      </div>

      <!-- Options -->
      <div
        class="border-t border-gray-200/80 dark:border-white/10"
        [attr.role]="current().multiSelect ? 'group' : 'radiogroup'"
        [attr.aria-label]="current().question"
      >
        @for (option of current().options; track option.label; let i = $index) {
          <button
            type="button"
            class="option-row"
            [class.option-row--on]="isSelected(option.label)"
            [attr.role]="current().multiSelect ? 'checkbox' : 'radio'"
            [attr.aria-checked]="isSelected(option.label)"
            [disabled]="resolving()"
            (click)="toggle(option.label)"
          >
            <span
              class="option-marker"
              [class.option-marker--multi]="current().multiSelect"
              [class.option-marker--on]="isSelected(option.label)"
              aria-hidden="true"
            >
              @if (isSelected(option.label)) {
                <ng-icon name="heroCheck" class="size-3" />
              } @else {
                <span class="option-index">{{ i + 1 }}</span>
              }
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-xs/5 font-medium text-gray-900 dark:text-gray-100">
                {{ option.label }}
              </span>
              @if (option.description) {
                <span class="block text-[11px]/4 text-gray-600 dark:text-gray-300">
                  {{ option.description }}
                </span>
              }
            </span>
          </button>
        }

        <!-- "Other": always offered, never supplied by the model. -->
        <div class="other-row">
          <span class="option-marker" aria-hidden="true">
            <ng-icon name="heroPencil" class="size-3" />
          </span>
          <input
            type="text"
            class="other-input"
            [placeholder]="'Something else…'"
            [ngModel]="otherText()"
            (ngModelChange)="setOther($event)"
            [disabled]="resolving()"
            [attr.aria-label]="'Other answer for ' + current().header"
            (keydown.enter)="submitIfReady()"
          />
        </div>
      </div>

      <!-- Footer: skip + submit -->
      <div
        class="flex items-center justify-between gap-2 border-t border-gray-200/80 px-3 py-2 dark:border-white/10"
      >
        <button
          type="button"
          class="skip-btn"
          (click)="skip()"
          [disabled]="resolving()"
        >
          Skip
        </button>

        <div class="flex items-center gap-2">
          @if (answeredCount() > 0 && total() > 1) {
            <span class="text-[11px] tabular-nums text-gray-600 dark:text-gray-300">
              {{ answeredCount() }}/{{ total() }} answered
            </span>
          }
          @if (index() < total() - 1) {
            <button type="button" class="action-btn" (click)="next()" [disabled]="resolving()">
              <span>Next</span>
              <ng-icon name="heroArrowRight" class="size-3" aria-hidden="true" />
            </button>
          } @else {
            <button
              type="button"
              class="action-btn"
              (click)="submit()"
              [disabled]="resolving() || answeredCount() === 0"
            >
              @if (resolving()) {
                <app-spinner size="sm" variant="on-solid" label="Working" />
                <span>Working…</span>
              } @else {
                <ng-icon name="heroCheck" class="size-3" aria-hidden="true" />
                <span>Submit</span>
              }
            </button>
          }
        </div>
      </div>
    </div>
  `,
  styles: `
    @reference "../../../../../../styles/theme.css";

    :host {
      display: block;
    }

    .question-prompt {
      animation: question-rise 0.32s cubic-bezier(0.16, 1, 0.3, 1);
    }

    /* Override the global \`.message-block p\` 16px margin (styles.css): inside
       the prompt these are a tight label + question pair. */
    .question-prompt p {
      margin-bottom: 0;
    }

    .option-row {
      display: flex;
      width: 100%;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.4rem 0.75rem;
      text-align: left;
      transition: background-color 120ms ease;
    }

    .option-row:hover:not(:disabled) {
      background: var(--color-gray-50);
    }

    .option-row:focus-visible {
      outline: 2px solid var(--color-secondary-500);
      outline-offset: -2px;
    }

    .option-row:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .option-row--on {
      background: var(--color-gray-100);
    }

    /* Dark overrides use :host-context, NOT \`:where(.dark, .dark *)\`.
       Angular's emulated encapsulation stamps its \`[_ngcontent-…]\` attribute
       onto every compound selector *inside* \`:where()\`, producing
       \`.dark[_ngcontent-…]\` — and <html class="dark"> carries no such
       attribute, so the rule silently never matches. That shipped a near-white
       selected row under near-white text in dark mode. */
    :host-context(.dark) .option-row:hover:not(:disabled) {
      background: rgb(255 255 255 / 0.04);
    }

    :host-context(.dark) .option-row--on {
      background: var(--color-gray-700);
    }

    .option-marker {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: 1.125rem;
      height: 1.125rem;
      margin-top: 0.1rem;
      border-radius: 9999px;
      border: 1px solid var(--color-gray-300);
      color: var(--color-gray-600);
      font-size: 10px;
      line-height: 1;
      transition:
        background-color 120ms ease,
        border-color 120ms ease,
        color 120ms ease;
    }

    /* Multi-select reads as a checkbox, single-select as a radio. */
    .option-marker--multi {
      border-radius: 0.25rem;
    }

    .option-marker--on {
      background: var(--color-secondary-500);
      border-color: var(--color-secondary-500);
      color: white;
    }

    :host-context(.dark) .option-marker {
      border-color: rgb(255 255 255 / 0.2);
      color: var(--color-gray-300);
    }

    :host-context(.dark) .option-marker--on {
      background: var(--color-secondary-500);
      border-color: var(--color-secondary-500);
      color: white;
    }

    .option-index {
      font-variant-numeric: tabular-nums;
    }

    .other-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.75rem 0.5rem;
    }

    .other-input {
      flex: 1 1 auto;
      min-width: 0;
      background: transparent;
      border: 0;
      border-bottom: 1px dashed var(--color-gray-300);
      padding: 0.15rem 0;
      font-size: 0.75rem;
      line-height: 1.25rem;
      color: var(--color-gray-900);
    }

    .other-input::placeholder {
      color: var(--color-gray-500);
    }

    .other-input:focus {
      outline: none;
      border-bottom-color: var(--color-secondary-500);
    }

    :host-context(.dark) .other-input {
      border-bottom-color: rgb(255 255 255 / 0.2);
      color: var(--color-gray-100);
    }

    :host-context(.dark) .other-input::placeholder {
      color: var(--color-gray-400);
    }

    .pager-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.25rem;
      height: 1.25rem;
      border-radius: 0.25rem;
      color: var(--color-gray-600);
      transition:
        background-color 120ms ease,
        color 120ms ease;
    }

    .pager-btn:hover:not(:disabled) {
      background: var(--color-gray-100);
      color: var(--color-gray-900);
    }

    .pager-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }

    .pager-btn:focus-visible {
      outline: 2px solid var(--color-gray-400);
      outline-offset: 1px;
    }

    :host-context(.dark) .pager-btn {
      color: var(--color-gray-300);
    }

    :host-context(.dark) .pager-btn:hover:not(:disabled) {
      background: rgb(255 255 255 / 0.08);
      color: white;
    }

    .action-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      border-radius: 0.375rem;
      padding: 0.25rem 0.625rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: white;
      background: var(--color-secondary-500);
      transition:
        background-color 120ms ease,
        transform 120ms ease;
    }

    .action-btn:hover:not(:disabled) {
      background: var(--color-secondary-600);
    }

    .action-btn:active:not(:disabled) {
      transform: translateY(1px);
    }

    .action-btn:focus-visible {
      outline: 2px solid var(--color-secondary-500);
      outline-offset: 2px;
    }

    .action-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .skip-btn {
      border-radius: 0.375rem;
      padding: 0.25rem 0.5rem;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--color-gray-600);
      background: transparent;
      transition:
        background-color 120ms ease,
        color 120ms ease;
    }

    .skip-btn:hover:not(:disabled) {
      background: var(--color-gray-100);
      color: var(--color-gray-900);
    }

    .skip-btn:focus-visible {
      outline: 2px solid var(--color-gray-400);
      outline-offset: 2px;
    }

    .skip-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }

    :host-context(.dark) .skip-btn {
      color: var(--color-gray-300);
    }

    :host-context(.dark) .skip-btn:hover:not(:disabled) {
      background: rgb(255 255 255 / 0.08);
      color: white;
    }

    @keyframes question-rise {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .question-prompt {
        animation: none;
      }
      .option-row,
      .option-marker,
      .action-btn,
      .skip-btn,
      .pager-btn {
        transition: none;
      }
    }
  `,
})
export class UserQuestionPromptComponent {
  request = input.required<UserQuestionRequest>();

  private questionService = inject(UserQuestionService);

  protected index = signal(0);
  protected resolving = signal(false);

  /** Answers accumulated across the pager, keyed by question header. */
  private readonly answers = signal<Record<string, UserQuestionAnswer>>({});

  protected total = computed<number>(() => this.request().questions.length);

  protected current = computed(() => {
    const questions = this.request().questions;
    // Clamp rather than index blindly: `request` is an input and could in
    // principle be swapped for a shorter set while the pager sits past its end.
    return questions[Math.min(this.index(), questions.length - 1)];
  });

  protected answeredCount = computed<number>(
    () =>
      Object.values(this.answers()).filter(
        (a) => a.selected.length > 0 || !!a.text?.trim(),
      ).length,
  );

  protected otherText = computed<string>(
    () => this.answers()[this.current().header]?.text ?? '',
  );

  protected isSelected(label: string): boolean {
    return !!this.answers()[this.current().header]?.selected.includes(label);
  }

  /**
   * Select an option. Multi-select toggles; single-select replaces, so a
   * second click on a different option moves the choice rather than adding to
   * it — and a second click on the SAME option clears it, which is the only
   * way to undo a misclick on a question the user would rather leave blank.
   */
  protected toggle(label: string): void {
    const header = this.current().header;
    const multi = this.current().multiSelect;
    this.answers.update((all) => {
      const existing = all[header] ?? { selected: [] };
      const has = existing.selected.includes(label);
      const selected = multi
        ? has
          ? existing.selected.filter((l) => l !== label)
          : [...existing.selected, label]
        : has
          ? []
          : [label];
      return { ...all, [header]: { ...existing, selected } };
    });
  }

  protected setOther(text: string): void {
    const header = this.current().header;
    this.answers.update((all) => {
      const existing = all[header] ?? { selected: [] };
      return { ...all, [header]: { ...existing, text } };
    });
  }

  protected back(): void {
    this.index.update((i) => Math.max(0, i - 1));
  }

  protected next(): void {
    this.index.update((i) => Math.min(this.total() - 1, i + 1));
  }

  /** Enter in the "Other" field advances, or submits on the last question. */
  protected submitIfReady(): void {
    if (this.index() < this.total() - 1) {
      this.next();
      return;
    }
    if (this.answeredCount() > 0) {
      void this.submit();
    }
  }

  protected async submit(): Promise<void> {
    if (this.resolving()) return;
    this.resolving.set(true);
    try {
      // Only answered questions are sent. The backend marks the rest skipped,
      // which is the honest record: the user chose not to answer them, and
      // inventing a default here would put words in their mouth.
      const answers: Record<string, UserQuestionAnswer> = {};
      for (const [header, answer] of Object.entries(this.answers())) {
        const text = answer.text?.trim();
        if (answer.selected.length === 0 && !text) continue;
        answers[header] = text
          ? { selected: answer.selected, text }
          : { selected: answer.selected };
      }
      await this.questionService.resolve(this.request().interruptId, { answers });
    } finally {
      this.resolving.set(false);
    }
  }

  protected async skip(): Promise<void> {
    if (this.resolving()) return;
    this.resolving.set(true);
    try {
      await this.questionService.skip(this.request().interruptId);
    } finally {
      this.resolving.set(false);
    }
  }
}
