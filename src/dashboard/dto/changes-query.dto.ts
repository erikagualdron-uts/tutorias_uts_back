import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PageQuery } from '../../common/page-query.js';

// The CAE list of recent changes pages up to 50 rows (the dashboard asks for 5).
export class ChangesQueryDto extends PageQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  declare limit: number;
}
