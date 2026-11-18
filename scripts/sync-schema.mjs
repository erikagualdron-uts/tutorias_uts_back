// The Prisma schema lives in tutorias_uts_db; this copy only exists so the client is generated into this repo.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('prisma', { recursive: true });
copyFileSync('../tutorias_uts_db/prisma/schema.prisma', 'prisma/schema.prisma');
