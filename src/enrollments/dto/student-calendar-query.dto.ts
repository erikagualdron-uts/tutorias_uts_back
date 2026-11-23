import { Matches } from 'class-validator';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// A range of days of Bogota (a week for the calendar); the service checks that they are real days and at most 7.
export class StudentCalendarQueryDto {
  @Matches(DAY)
  from!: string;

  @Matches(DAY)
  to!: string;
}
