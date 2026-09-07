/**
 * Utility functions for text manipulation and formatting in charts.
 */

/**
 * Truncates a string to a maximum length and appends an ellipsis if truncated.
 * Handles Unicode surrogate pairs correctly.
 *
 * @param text The input string to truncate
 * @param maxLength Maximum number of characters allowed (including ellipsis)
 * @param ellipsis Ellipsis character(s) to append, defaults to '…'
 * @returns Truncated string, or empty string if input is null/undefined
 */
export function truncateText(
  text: string | null | undefined,
  maxLength: number,
  ellipsis: string = '…'
): string {
  if (text == null) {
    return '';
  }
  const str = String(text);
  if (maxLength <= 0) {
    return '';
  }

  const chars = Array.from(str);
  if (chars.length <= maxLength) {
    return str;
  }

  const ellipsisChars = Array.from(ellipsis);
  if (maxLength <= ellipsisChars.length) {
    return chars.slice(0, maxLength).join('');
  }

  const visibleLength = maxLength - ellipsisChars.length;
  return chars.slice(0, visibleLength).join('') + ellipsis;
}
