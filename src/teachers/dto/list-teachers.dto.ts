import { ListAccountsQuery } from '../../accounts/list-accounts.dto.js';

// `GET /teachers` (spec 010: the module form picks a teacher; spec 016: the CAE manages accounts).
export class ListTeachersQuery extends ListAccountsQuery {}
