import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { available, PERSON, type PersonRow } from './chat-views.js';

// SQL condition on a message `m` and its conversation `c`: can this user see that message?
//  - a direct chat: the user is one of its two members;
//  - a module chat: the teacher of the module sees everything; a student needs an ACTIVE enrollment now
//    and sees only what was written while enrolled (from the enrollment until it was cancelled).
export const visibleTo = (userId: string) => Prisma.sql`(
  (c.type = 'DIRECT' AND EXISTS (
    SELECT 1 FROM conversation_members x WHERE x.conversation_id = c.id AND x.user_id = ${userId}::uuid))
  OR (c.type = 'MODULE' AND (
    EXISTS (SELECT 1 FROM modules mo WHERE mo.id = c.module_id AND mo.teacher_id = ${userId}::uuid AND mo.deleted_at IS NULL)
    OR (
      EXISTS (SELECT 1 FROM enrollments a WHERE a.module_id = c.module_id AND a.student_id = ${userId}::uuid
        AND a.status = 'ACTIVE' AND a.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM enrollments e WHERE e.module_id = c.module_id AND e.student_id = ${userId}::uuid
        AND e.deleted_at IS NULL AND e.created_at <= m.created_at
        AND (e.status = 'ACTIVE' OR m.created_at < e.effective_until))
    )
  ))
)`;

// Everyone who takes part in a module chat today: its teacher and the students with an ACTIVE enrollment,
// only accounts that can receive.
export async function moduleParticipants(prisma: PrismaService, moduleId: string): Promise<PersonRow[]> {
  const module = await prisma.module.findFirst({
    where: { id: moduleId, deletedAt: null },
    select: {
      teacher: { select: PERSON },
      enrollments: { where: { status: 'ACTIVE', deletedAt: null }, select: { student: { select: PERSON } } },
    },
  });
  if (!module) return [];
  return [module.teacher, ...module.enrollments.map((e) => e.student)].filter(available);
}
