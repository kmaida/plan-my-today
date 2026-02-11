/**
 * Date utility functions for meeting note date parsing and business days calculation
 */

// Regex patterns for various date formats commonly found in meeting note filenames
const ISO_DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/; // YYYY-MM-DD
const US_DATE_PATTERN = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/; // M/D/YYYY or MM/DD/YYYY
const WRITTEN_DATE_PATTERN =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2}),? (\d{4})\b/i; // Jan 27, 2026

// Minimum year to consider valid (prevents false positives from version numbers, etc.)
const MIN_VALID_YEAR = 2020;

/**
 * Parse a date from a meeting note filename
 *
 * Supports multiple formats:
 * - ISO: "YYYY-MM-DD" (e.g., "Team Sync - 2026-01-27")
 * - US: "M/D/YYYY" (e.g., "Meeting 1/27/2026")
 * - Written: "Mon DD, YYYY" (e.g., "Standup - Jan 27, 2026")
 *
 * @param filename - The filename to parse
 * @returns Parsed date or null if no valid date found
 */
export function parseDateFromFilename(filename: string): Date | null {
  if (!filename) return null;

  // Try ISO format first (most reliable)
  const isoMatch = filename.match(ISO_DATE_PATTERN);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
    if (isValidDate(date)) return date;
  }

  // Try US format
  const usMatch = filename.match(US_DATE_PATTERN);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    const date = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10));
    if (isValidDate(date)) return date;
  }

  // Try written format
  const writtenMatch = filename.match(WRITTEN_DATE_PATTERN);
  if (writtenMatch) {
    const [, monthName, day, year] = writtenMatch;
    const monthMap: Record<string, number> = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const month = monthMap[monthName.toLowerCase().slice(0, 3)];
    if (month !== undefined) {
      const date = new Date(parseInt(year, 10), month, parseInt(day, 10));
      if (isValidDate(date)) return date;
    }
  }

  return null;
}

/**
 * Validate that a parsed date is reasonable
 * - Not before MIN_VALID_YEAR (likely a parsing error)
 * - Not too far in the future (> 1 year)
 * - Is a valid date (not Feb 30, etc.)
 *
 * @param date - Date to validate
 * @returns True if date is valid and reasonable
 */
function isValidDate(date: Date): boolean {
  // Check if date is actually valid
  if (Number.isNaN(date.getTime())) return false;

  const year = date.getFullYear();

  // Must be after minimum valid year
  if (year < MIN_VALID_YEAR) return false;

  // Must not be more than 1 year in the future (likely an error)
  const oneYearFromNow = new Date();
  oneYearFromNow.setFullYear(oneYearFromNow.getFullYear() + 1);
  if (date > oneYearFromNow) return false;

  return true;
}

/**
 * Calculate the number of business days between two dates
 * Business days are weekdays only (Monday-Friday)
 * Weekends are excluded from the count
 *
 * @param date - The target date
 * @param referenceDate - The reference date (defaults to today)
 * @returns Number of business days between the dates (always positive)
 */
export function getBusinessDaysAgo(date: Date, referenceDate: Date = new Date()): number {
  // Normalize both dates to midnight for consistent comparison
  const startDate = new Date(date);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(referenceDate);
  endDate.setHours(0, 0, 0, 0);

  // Determine which date is earlier
  const [earlier, later] = startDate <= endDate ? [startDate, endDate] : [endDate, startDate];

  let businessDays = 0;
  const current = new Date(earlier);

  // Iterate day by day, counting only weekdays
  while (current < later) {
    const dayOfWeek = current.getDay();
    // 0 = Sunday, 6 = Saturday; 1-5 = Monday-Friday
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDays++;
    }
    current.setDate(current.getDate() + 1);
  }

  return businessDays;
}

/**
 * Check if a date is within a specified number of business days
 *
 * @param targetDate - The date to check
 * @param maxBusinessDays - Maximum number of business days allowed
 * @param referenceDate - The reference date (defaults to today)
 * @returns True if targetDate is within maxBusinessDays from referenceDate
 */
export function isWithinBusinessDays(
  targetDate: Date,
  maxBusinessDays: number,
  referenceDate: Date = new Date()
): boolean {
  // Reject future dates (meeting hasn't happened yet)
  if (targetDate > referenceDate) return false;

  const businessDaysAgo = getBusinessDaysAgo(targetDate, referenceDate);
  return businessDaysAgo <= maxBusinessDays;
}
