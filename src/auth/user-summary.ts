import type { StudentProfile, TeacherProfile, User } from '@prisma/client';

export type UserWithProfiles = User & {
  studentProfile: StudentProfile | null;
  teacherProfile: TeacherProfile | null;
};

// Public shape of a user (UserSummary in the contract); never includes passwordHash.
export function toUserSummary(user: UserWithProfiles) {
  const profile = user.studentProfile ?? user.teacherProfile;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    locale: user.locale,
    firstName: profile?.firstName,
    lastName: profile?.lastName,
  };
}
