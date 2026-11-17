// Source of public holidays for the import (spec 010, research.md R-9). The real client queries
// Nager.Date; tests replace it with a double through the HOLIDAYS_CLIENT token.
export interface HolidayEntry {
  date: string; // 'YYYY-MM-DD'
  name: string;
}

export interface HolidaysClient {
  // Resolves with the valid holidays of the year, or throws
  // AppException(502, 'HOLIDAYS_IMPORT_UNAVAILABLE') when the service fails, is too slow or answers
  // something unusable.
  fetchYear(year: number): Promise<HolidayEntry[]>;
}

export const HOLIDAYS_CLIENT = Symbol('HOLIDAYS_CLIENT');
