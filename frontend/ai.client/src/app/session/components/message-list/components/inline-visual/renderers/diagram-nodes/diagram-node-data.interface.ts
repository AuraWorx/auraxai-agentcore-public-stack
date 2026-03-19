/**
 * Shared data interface for all diagram node templates.
 * Matches the backend tool's node data payload structure.
 */
export interface DiagramNodeData {
  label: string;
  description?: string;
  icon?: string;
  status?: 'active' | 'warning' | 'error' | 'inactive';
  color?: 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'pink' | 'teal' | 'gray';
}

/** Maps status values to Tailwind border color classes */
export const STATUS_BORDER_COLORS: Record<string, string> = {
  active: 'border-green-500 dark:border-green-400',
  warning: 'border-amber-500 dark:border-amber-400',
  error: 'border-red-500 dark:border-red-400',
  inactive: 'border-gray-300 dark:border-gray-600',
};

/** Maps status values to Tailwind background indicator colors */
export const STATUS_DOT_COLORS: Record<string, string> = {
  active: 'bg-green-500',
  warning: 'bg-amber-500',
  error: 'bg-red-500',
  inactive: 'bg-gray-400',
};

/** Maps color keys to Tailwind background accent classes */
export const COLOR_ACCENTS: Record<string, string> = {
  blue: 'bg-blue-500/10 border-blue-500/30 dark:bg-blue-500/20 dark:border-blue-400/30',
  green: 'bg-green-500/10 border-green-500/30 dark:bg-green-500/20 dark:border-green-400/30',
  amber: 'bg-amber-500/10 border-amber-500/30 dark:bg-amber-500/20 dark:border-amber-400/30',
  red: 'bg-red-500/10 border-red-500/30 dark:bg-red-500/20 dark:border-red-400/30',
  purple: 'bg-purple-500/10 border-purple-500/30 dark:bg-purple-500/20 dark:border-purple-400/30',
  pink: 'bg-pink-500/10 border-pink-500/30 dark:bg-pink-500/20 dark:border-pink-400/30',
  teal: 'bg-teal-500/10 border-teal-500/30 dark:bg-teal-500/20 dark:border-teal-400/30',
  gray: 'bg-gray-500/10 border-gray-500/30 dark:bg-gray-500/20 dark:border-gray-400/30',
};
