import { PqrsStatus } from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PageQuery } from '../../common/page-query.js';

export class ListMinePqrsQuery extends PageQuery {
  @IsOptional()
  @IsEnum(PqrsStatus)
  status?: PqrsStatus;
}

export class ListPqrsQuery extends ListMinePqrsQuery {
  @IsOptional()
  @IsUUID()
  typeId?: string;

  @IsOptional()
  @IsIn(['TEACHER', 'STUDENT'])
  authorRole?: 'TEACHER' | 'STUDENT';
}
