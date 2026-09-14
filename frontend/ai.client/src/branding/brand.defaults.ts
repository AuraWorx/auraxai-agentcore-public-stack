/**
 * Default_Branding constants.
 *
 * These are the built-in fallback values used whenever `Brand_Config`
 * (see `brand.config.ts`) is absent, unparseable, or has an invalid/
 * out-of-bounds field for a given slot. They also define the current
 * out-of-the-box appearance of the application, so a clean checkout
 * renders exactly as it did before branding was centralized.
 *
 * All values here are frozen to signal they are immutable defaults.
 * See design.md "Data Models" and "Default_Branding" for details.
 */

import type { BrandColors, BrandLogoAssets, BrandSurfaces, PartOfDay } from './brand.types';

/** Default light/dark logo paths (served from /public). */
export const DEFAULT_LOGO: BrandLogoAssets = Object.freeze({
  light: 'img/logo-light.png',
  dark: 'img/logo-dark.png',
});

/** Default app name / logo alt text. */
export const DEFAULT_APP_NAME = 'Boise State Logo';

/** Fixed default label used when appName normalization fails (Requirement 3.5). */
export const DEFAULT_ALT_LABEL = 'Logo';

/**
 * Default greeting templates (use {name} as placeholder for first name).
 * Copied verbatim from the current `greetingTemplates` array in
 * `session.page.ts`.
 */
export const DEFAULT_GREETING_TEMPLATES: readonly string[] = Object.freeze([
  'How can I help you today, {name}?',
  'What would you like to know, {name}?',
  'Ready to assist you, {name}!',
  'What can I do for you, {name}?',
  "Let's get started, {name}!",
]);

/**
 * Default fallback greetings when a user name is not available.
 * Copied verbatim from the current `fallbackGreetings` array in
 * `session.page.ts`.
 */
export const DEFAULT_FALLBACK_GREETINGS: readonly string[] = Object.freeze([
  'How can I help you today?',
  'What would you like to know?',
  'Ready to assist you!',
  'What can I do for you?',
  "Let's get started!",
]);

/**
 * Default greetings that only make sense during their own part of the day.
 *
 * Pooled *with* `DEFAULT_GREETING_TEMPLATES`, not instead of it: half the draw
 * is a line that knows what time it is, half is a line that works any time.
 * Pooling rather than replacing is what keeps the app from feeling like it has
 * exactly one thing to say each morning.
 *
 * The two arrays above are deliberately left alone — they are pinned verbatim
 * by `brand.defaults.golden.spec.ts` as the pre-branding-refactor greetings,
 * and that guard is worth more than tidiness.
 */
export const DEFAULT_TIME_OF_DAY_GREETING_TEMPLATES: Readonly<
  Record<PartOfDay, readonly string[]>
> = Object.freeze({
  morning: Object.freeze([
    'Good morning, {name}!',
    'Bright and early, {name}.',
    "Morning, {name} — what's first today?",
    "Coffee's on. What are we working on, {name}?",
    'Fresh start, {name}. Where do we begin?',
  ]),
  afternoon: Object.freeze([
    'Good afternoon, {name}!',
    'Afternoon, {name}. What are we working on?',
    'Back at it, {name}?',
    "What's next on the list, {name}?",
    'Afternoon, {name} — where should we pick up?',
  ]),
  evening: Object.freeze([
    'Good evening, {name}!',
    'Evening, {name}. What can I take off your plate?',
    'One more thing before you log off, {name}?',
    'Still going, {name}? What do you need?',
    'Evening, {name}. Where should we start?',
  ]),
  night: Object.freeze([
    'Burning the midnight oil, {name}?',
    'Working late tonight, {name}?',
    'The quiet hours, {name}. What are we tackling?',
    'Still up, {name}? Let me help.',
    'Late one, {name}. Where should we start?',
  ]),
});

/** Part-of-day counterparts to `DEFAULT_FALLBACK_GREETINGS`, used when no name is known. */
export const DEFAULT_TIME_OF_DAY_FALLBACK_GREETINGS: Readonly<
  Record<PartOfDay, readonly string[]>
> = Object.freeze({
  morning: Object.freeze([
    'Good morning!',
    'Bright and early.',
    "Morning — what's first today?",
    "Coffee's on. What are we working on?",
    'Fresh start. Where do we begin?',
  ]),
  afternoon: Object.freeze([
    'Good afternoon!',
    'What are we working on this afternoon?',
    'Back at it?',
    "What's next on the list?",
    'Afternoon — where should we pick up?',
  ]),
  evening: Object.freeze([
    'Good evening!',
    'What can I take off your plate tonight?',
    'One more thing before you log off?',
    'Still going? What do you need?',
    'Evening. Where should we start?',
  ]),
  night: Object.freeze([
    'Burning the midnight oil?',
    'Working late tonight?',
    'The quiet hours. What are we tackling?',
    'Still up? Let me help.',
    'Late one. Where should we start?',
  ]),
});

/** Built-in ultimate-default greeting when templates and fallbacks are both empty (Requirement 4.8). */
export const DEFAULT_GREETING = 'How can I help you today?';

/** Default brand colors (single hex input per role). */
export const DEFAULT_COLORS: BrandColors = Object.freeze({
  primary: '#0033a0',
  secondary: '#d64309',
  tertiary: '#0072ce',
});

/** Default page title. */
export const DEFAULT_PAGE_TITLE = 'AgentCore';

/**
 * Default surface anchors — the hex round-trips of Tailwind's own
 * gray-50, gray-900, and white, so a clean checkout's derived neutral
 * ramp (see generate-surface-theme.ts) is byte-identical to
 * TAILWIND_GRAY_RAMP and no pixel changes.
 *
 * `light` and `dark` are `hexToOklch`/`oklchToSrgb` round-trips of
 * Tailwind v4's `--color-gray-50` / `--color-gray-900` (not hand-typed
 * hex), so the zero-diff property in generate-surface-theme.spec.ts holds
 * exactly rather than approximately.
 */
export const DEFAULT_SURFACES: BrandSurfaces = Object.freeze({
  light: '#f9fafb',
  dark: '#101828',
  raised: '#ffffff',
});